/**
 * ocpipe agent integration.
 *
 * Dispatches prompts to configured coding-agent backends.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, type WriteStream } from 'fs'
import { randomUUID } from 'crypto'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { OutputLimitError } from './errors.js'
import { PROJECT_ROOT, TMP_DIR } from './paths.js'
import type { RunAgentOptions, RunAgentResult } from './types.js'
import { runOmpAgent } from './omp.js'
import { runPrimeAgent } from './prime.js'
import { runPiAgent } from './pi.js'

/** runAgent dispatches to the selected backend. */
export async function runAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const backend = options.model.backend ?? 'omp'

  if (backend === 'prime') {
    return runPrimeAgent(options)
  }

  if (backend === 'claude-code') {
    const { runClaudeCodeAgent } = await import('./claude-code.js')
    return runClaudeCodeAgent(options)
  }

  if (backend === 'codex') {
    const { runCodexAgent } = await import('./codex.js')
    return runCodexAgent(options)
  }

  if (backend === 'opencode') {
    return runOpencodeAgent(options)
  }

  if (backend === 'pi') {
    return runPiAgent(options)
  }

  if (backend === 'omp') {
    return runOmpAgent(options)
  }

  const unreachable: never = backend
  throw new Error(`Unsupported backend: ${unreachable}`)
}
const MAX_CHILD_OUTPUT_BYTES = 512 * 1024 * 1024
const MAX_STDERR_LINE_BYTES = 8 * 1024 * 1024

class OutputBudget {
  private usedBytes = 0

  reserve(bytes: number, source: string): void {
    if (this.usedBytes + bytes > MAX_CHILD_OUTPUT_BYTES) {
      throw new OutputLimitError(
        `OpenCode ${source} output`,
        MAX_CHILD_OUTPUT_BYTES,
      )
    }
    this.usedBytes += bytes
  }
}

class OutputFile {
  private readonly stream: WriteStream
  private readonly onError: (error: Error) => void
  private error: Error | undefined
  private closePromise: Promise<void> | undefined

  constructor(
    readonly path: string,
    budget: OutputBudget,
    source: string,
    onError: (error: Error) => void,
  ) {
    this.onError = onError
    this.stream = createWriteStream(path, { mode: 0o600 })
    this.stream.on('error', (error) => {
      this.fail(error)
    })
    this.budget = budget
    this.source = source
  }

  private readonly budget: OutputBudget
  private readonly source: string

  get failed(): boolean {
    return this.error !== undefined
  }

  write(chunk: Buffer): boolean {
    if (this.error) return false
    try {
      this.budget.reserve(chunk.byteLength, this.source)
    } catch (error) {
      this.fail(error)
      return false
    }
    return this.stream.write(chunk)
  }

  async waitForDrain(): Promise<void> {
    if (!this.stream.writableNeedDrain || this.error) return
    await new Promise<void>((resolve) => {
      const done = () => {
        this.stream.removeListener('drain', done)
        this.stream.removeListener('error', done)
        resolve()
      }
      this.stream.once('drain', done)
      this.stream.once('error', done)
    })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = new Promise<void>((resolve) => {
      const done = () => {
        this.stream.removeListener('finish', done)
        this.stream.removeListener('close', done)
        this.stream.removeListener('error', done)
        resolve()
      }
      if (this.stream.destroyed || this.stream.writableFinished) {
        resolve()
        return
      }
      this.stream.once('finish', done)
      this.stream.once('close', done)
      this.stream.once('error', done)
      this.stream.end()
    })
    return this.closePromise
  }

  private fail(error: unknown): void {
    if (this.error) return
    this.error = error instanceof Error ? error : new Error(String(error))
    this.onError(this.error)
  }
}

async function writeChildChunk(
  stream: { pause?: () => unknown; resume?: () => unknown },
  file: OutputFile,
  chunk: Buffer,
): Promise<void> {
  if (file.write(chunk) && !file.failed) return
  if (file.failed) return
  stream.pause?.()
  await file.waitForDrain()
  if (!file.failed) stream.resume?.()
}
async function writeConsoleChunk(chunk: Buffer): Promise<void> {
  if (process.stderr.write(chunk)) return
  await new Promise<void>((resolve) => {
    process.stderr.once('drain', resolve)
  })
}

class StderrTracker {
  private pending = ''
  private readonly diagnosticLines: string[] = []
  private readonly lastLines: string[] = []
  private matchedErrorPattern: RegExp | undefined
  private knownError = false
  private sawError = false
  private sessionId = ''

  consume(text: string): void {
    let cursor = 0
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor)
      if (newline < 0) {
        this.append(text.slice(cursor))
        return
      }
      this.append(text.slice(cursor, newline))
      cursor = newline + 1
      this.recordLine(this.pending)
      this.pending = ''
    }
  }

  finish(): void {
    if (this.pending) {
      this.recordLine(this.pending)
      this.pending = ''
    }
  }

  get hasKnownError(): boolean {
    return this.knownError
  }
  get knownErrorPattern(): RegExp | undefined {
    return this.matchedErrorPattern
  }

  get hasError(): boolean {
    return this.sawError
  }

  get newSessionId(): string {
    return this.sessionId
  }

  getLastLines(count: number): string {
    return this.lastLines.slice(-count).join('\n')
  }

  getDiagnosticLines(): string {
    return this.diagnosticLines.join('\n')
  }

  private append(text: string): void {
    if (
      Buffer.byteLength(this.pending, 'utf8') +
        Buffer.byteLength(text, 'utf8') >
      MAX_STDERR_LINE_BYTES
    ) {
      throw new OutputLimitError('OpenCode stderr line', MAX_STDERR_LINE_BYTES)
    }
    this.pending += text
  }

  private recordLine(line: string): void {
    this.lastLines.push(line)
    if (this.lastLines.length > 10) this.lastLines.shift()
    if (line.includes('Error')) this.sawError = true

    if (line.startsWith('[session:')) {
      this.sessionId = line.trim().slice(9, -1)
      return
    }
    for (const { pattern } of knownOpenCodeErrors) {
      if (pattern.test(line)) {
        this.knownError = true
        this.matchedErrorPattern ??= pattern
      }
    }

    if (
      line.includes('Error') ||
      line.includes('error:') ||
      knownOpenCodeErrors.some(({ pattern }) => pattern.test(line))
    ) {
      if (this.diagnosticLines.length < 5) this.diagnosticLines.push(line)
    }
  }
}

async function runOpencodeAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const {
    prompt,
    model,
    sessionId,
    timeoutSec = 3600,
    workdir,
    opencode,
    signal,
  } = options

  if (!model.providerID) {
    throw new Error('providerID is required for OpenCode backend')
  }

  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const cwd = workdir ?? PROJECT_ROOT
  const modelStr = `${model.providerID}/${model.modelID}`
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')
  console.error(
    `\n>>> OpenCode [${modelStr}] ${sessionInfo}: ${promptPreview}...`,
  )

  const promptDir = opencode?.promptDir ?? TMP_DIR
  await mkdir(promptDir, { recursive: true })
  await mkdir(TMP_DIR, { recursive: true })
  const promptFile = join(promptDir, `ocpipe_prompt_${randomUUID()}.txt`)
  const outputId = randomUUID()
  const stdoutPath = join(TMP_DIR, `ocpipe_output_${outputId}.stdout`)
  const stderrPath = join(TMP_DIR, `ocpipe_output_${outputId}.stderr`)
  await writeFile(promptFile, prompt)

  const args = [
    'run',
    '--format',
    'default',
    '--model',
    modelStr,
    '--prompt-file',
    promptFile,
  ]

  if (sessionId) {
    args.push('--session', sessionId)
  }
  if (model.variant) {
    args.push('--model-variant', model.variant)
  }
  if (model.variantThinkingBudget !== undefined) {
    args.push(
      '--model-variant-thinking-budget',
      String(model.variantThinkingBudget),
    )
  }

  const command = opencode?.command ?? 'opencode'

  const { promise, resolve, reject } = Promise.withResolvers<RunAgentResult>()
  const budget = new OutputBudget()
  const stderrTracker = new StderrTracker()
  let proc: ChildProcess | undefined
  const timers: { timeout?: NodeJS.Timeout } = {}
  let settled = false
  let closeFilesPromise: Promise<void> | undefined
  let killTimer: NodeJS.Timeout | undefined
  let cleanupPromise: Promise<void> | undefined

  const closeFiles = (): Promise<void> => {
    if (!closeFilesPromise) {
      closeFilesPromise = Promise.all([
        stdoutFile.close(),
        stderrFile.close(),
      ]).then(() => undefined)
    }
    return closeFilesPromise
  }

  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await closeFiles()
        await Promise.all(
          [promptFile, stdoutPath, stderrPath].map((path) =>
            unlink(path).catch(() => {}),
          ),
        )
      })()
    }
    return cleanupPromise
  }

  const stopProcess = () => {
    if (!proc || proc.killed) return
    proc.kill('SIGTERM')
    killTimer = setTimeout(() => {
      if (proc && !proc.killed) proc.kill('SIGKILL')
    }, 1000)
  }

  const fail = (error: unknown): void => {
    if (settled) return
    settled = true
    clearTimeout(timers.timeout)
    clearTimeout(killTimer)
    signal?.removeEventListener('abort', abortHandler)
    stopProcess()
    const cause = error instanceof Error ? error : new Error(String(error))
    reject(cause)
    void cleanup()
  }

  const stdoutFile = new OutputFile(stdoutPath, budget, 'stdout', fail)
  const stderrFile = new OutputFile(stderrPath, budget, 'stderr', fail)

  const abortHandler = () => {
    if (settled) return
    console.error(`\n[abort] Killing OpenCode subprocess...`)
    fail(new Error('Request aborted'))
  }

  try {
    proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opencode?.env },
    })
  } catch (error) {
    fail(error)
    return promise
  }

  if (!proc.stdout || !proc.stderr) {
    fail(new Error('OpenCode subprocess did not provide output streams'))
    return promise
  }

  const stdoutStream = proc.stdout
  const stderrStream = proc.stderr

  stderrStream.on('data', (data: Buffer) => {
    if (settled) return
    void (async () => {
      try {
        const text = data.toString()
        stderrTracker.consume(text)
        await writeChildChunk(stderrStream, stderrFile, data)
      } catch (error) {
        fail(error)
      }
    })()
  })

  stdoutStream.on('data', (data: Buffer) => {
    if (settled) return
    void (async () => {
      try {
        await writeChildChunk(stdoutStream, stdoutFile, data)
        await writeConsoleChunk(data)
      } catch (error) {
        fail(error)
      }
    })()
  })

  timers.timeout =
    timeoutSec > 0
      ? setTimeout(() => {
          fail(new Error(`Timeout after ${timeoutSec}s`))
        }, timeoutSec * 1000)
      : undefined
  signal?.addEventListener('abort', abortHandler, { once: true })

  proc.on('close', (code) => {
    void (async () => {
      clearTimeout(timers.timeout)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abortHandler)
      await closeFiles()
      if (settled) {
        await cleanup()
        return
      }

      stderrTracker.finish()
      if (code !== 0) {
        const lastLines = stderrTracker.getLastLines(5)
        const detail = lastLines ? `\n${lastLines}` : ''
        fail(new Error(`OpenCode exited with code ${code}${detail}`))
        return
      }

      if (stderrTracker.hasKnownError) {
        const knownError = knownOpenCodeErrors.find(
          ({ pattern }) => pattern === stderrTracker.knownErrorPattern,
        )
        if (knownError) {
          fail(
            new Error(
              `OpenCode ${knownError.message}:\n${stderrTracker.getDiagnosticLines()}`,
            ),
          )
          return
        }
      }

      let response: string
      try {
        response = (await readFile(stdoutPath, 'utf8')).trim()
      } catch (error) {
        fail(error)
        return
      }
      const newSessionId =
        stderrTracker.newSessionId || (sessionId ? sessionId : '')
      if (newSessionId) {
        response =
          (await exportSession(newSessionId, cwd, command, opencode?.env)) ??
          response
      }

      if (response.length === 0 && stderrTracker.hasError) {
        const lastLines = stderrTracker.getLastLines(10)
        fail(
          new Error(
            `OpenCode returned empty response with errors:\n${lastLines}`,
          ),
        )
        return
      }

      const sessionStr = newSessionId || 'none'
      console.error(
        `<<< OpenCode done (${response.length} chars) [session:${sessionStr}]`,
      )
      settled = true
      await cleanup()
      resolve({ text: response, sessionId: newSessionId })
    })().catch(fail)
  })

  proc.on('error', (error) => {
    fail(error)
  })

  return promise
}

async function exportSession(
  sessionId: string,
  workdir: string,
  command: string,
  env: Record<string, string> | undefined,
): Promise<string | null> {
  const exportFile = join(TMP_DIR, `opencode_export_${randomUUID()}.json`)

  try {
    await mkdir(TMP_DIR, { recursive: true })
    const proc = Bun.spawn(
      [
        command,
        'session',
        'export',
        sessionId,
        '--format',
        'json',
        '--turn',
        '-1',
        '-o',
        exportFile,
      ],
      {
        cwd: workdir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env },
      },
    )

    await proc.exited
    const file = Bun.file(exportFile)
    if (!(await file.exists())) return null

    const data = (await file.json()) as {
      messages?: Array<{
        info?: { role?: string }
        parts?: Array<{ type?: string; text?: string }>
      }>
    }
    void unlink(exportFile).catch(() => {})

    const textParts: string[] = []
    for (const msg of data.messages ?? []) {
      if (msg.info?.role !== 'assistant') continue
      for (const part of msg.parts ?? []) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text)
        }
      }
    }

    return textParts.length > 0 ? textParts.join('\n') : null
  } catch {
    void unlink(exportFile).catch(() => {})
    return null
  }
}

const knownOpenCodeErrors: ReadonlyArray<{ pattern: RegExp; message: string }> =
  [
    {
      pattern: /ProviderModelNotFoundError/,
      message: 'Provider/model not found',
    },
    { pattern: /ModelNotFoundError/, message: 'Model not found' },
    { pattern: /ProviderNotFoundError/, message: 'Provider not found' },
    { pattern: /API key.*not.*found/i, message: 'API key not configured' },
    { pattern: /authentication.*failed/i, message: 'Authentication failed' },
  ]

/** logStep logs a step header for workflow progress. */
export function logStep(step: number, title: string, detail = ''): void {
  const detailStr = detail ? ` (${detail})` : ''
  console.log(`\n${'='.repeat(60)}`)
  console.log(`STEP ${step}: ${title}${detailStr}`)
  console.log('='.repeat(60))
}

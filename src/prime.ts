/**
 * ocpipe Prime Agent integration.
 *
 * Runs Prime Agent through its headless JSON print mode.
 */

import { spawn, type ChildProcess } from 'child_process'
import { PROJECT_ROOT } from './paths.js'
import type { PrimeOptions, RunAgentOptions, RunAgentResult } from './types.js'

interface PrimeProcessRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

interface PrimeProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface PrimeProcess {
  run(req: PrimeProcessRequest): Promise<PrimeProcessResult>
}

interface PrimeRunSummary {
  sawJsonEvent: boolean
  sessionId: string
  finalMessage: string
  assistantError: string
}

const defaultPrimeCommand = 'prime-agent'

/** runPrimeAgent executes a Prime Agent turn. */
export async function runPrimeAgent(
  options: RunAgentOptions,
  processRunner: PrimeProcess = commandPrimeProcess,
): Promise<RunAgentResult> {
  const {
    prompt,
    model,
    sessionId,
    timeoutSec = 3600,
    workdir,
    prime,
    signal,
  } = options

  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const cwd = workdir ?? PROJECT_ROOT
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const modelInfo = model.modelID ? ` [${model.modelID}]` : ''
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')
  console.error(
    `\n>>> Prime Agent${modelInfo} ${sessionInfo}: ${promptPreview}...`,
  )

  const abort = new AbortController()
  const abortHandler = () => abort.abort()
  signal?.addEventListener('abort', abortHandler, { once: true })
  let timedOut = false
  const timeout =
    timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true
          abort.abort()
        }, timeoutSec * 1000)
      : null

  try {
    const result = await processRunner.run({
      command: prime?.command ?? defaultPrimeCommand,
      args: buildPrimeArgs(model.modelID, cwd, sessionId, prompt, prime),
      cwd: prime?.processCwd ?? cwd,
      env: { ...process.env, ...prime?.env },
      signal: abort.signal,
    })
    const summary = parsePrimeOutput(result.stdout)
    const detail = result.signal
      ? `signal ${result.signal}`
      : `status ${result.exitCode}`
    if (result.exitCode !== 0 || result.signal) {
      const message = firstNonEmpty(
        summary.finalMessage,
        summary.assistantError,
        result.stderr.trim(),
        result.stdout.trim(),
        detail,
      )
      throw new Error(`Prime Agent exited with ${detail}: ${message}`)
    }

    if (summary.assistantError) {
      throw new Error(summary.assistantError)
    }

    const response = firstNonEmpty(
      summary.finalMessage,
      summary.sawJsonEvent ? '' : result.stdout.trim(),
    )
    if (!response) {
      throw new Error('Prime Agent returned an empty final message')
    }

    const nextSessionId = firstNonEmpty(summary.sessionId, sessionId ?? '')
    console.error(
      `<<< Prime Agent done (${response.length} chars)${nextSessionId ? ` [session:${nextSessionId}]` : ''}`,
    )
    return { text: response, sessionId: nextSessionId }
  } catch (error) {
    if (timedOut) {
      throw new Error(`Timeout after ${timeoutSec}s`, { cause: error })
    }
    if (signal?.aborted) {
      throw new Error('Request aborted', { cause: error })
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener('abort', abortHandler)
  }
}

function buildPrimeArgs(
  modelID: string,
  cwd: string,
  sessionId: string | undefined,
  prompt: string,
  prime: PrimeOptions | undefined,
): string[] {
  const args = ['--print', '--mode', 'json', '--cwd', cwd]
  if (modelID) args.push('--model', modelID)
  if (prime?.thinking) args.push('--thinking', prime.thinking)
  if (sessionId) args.push('--resume', sessionId)
  args.push(...(prime?.extraArgs ?? []))
  if (prompt) args.push('--', prompt)
  return args
}

function parsePrimeOutput(stdout: string): PrimeRunSummary {
  const summary: PrimeRunSummary = {
    sawJsonEvent: false,
    sessionId: '',
    finalMessage: '',
    assistantError: '',
  }
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    summary.sawJsonEvent = true
    if (stringValue(event.type) === 'session') {
      summary.sessionId = firstNonEmpty(
        stringValue(event.id),
        stringValue(event.sessionId),
        summary.sessionId,
      )
      continue
    }
    if (stringValue(event.type) === 'message_end') {
      const error = assistantError(event.message)
      const text = assistantText(event.message)
      if (error) {
        summary.assistantError = error
        summary.finalMessage = ''
      } else if (text) {
        summary.assistantError = ''
        summary.finalMessage = text
      }
    }
  }
  if (!summary.sawJsonEvent) summary.finalMessage = stdout.trim()
  return summary
}

function assistantError(raw: unknown): string {
  if (!isRecord(raw) || stringValue(raw.role) !== 'assistant') return ''
  const stopReason = stringValue(raw.stopReason)
  if (stopReason !== 'error' && stopReason !== 'aborted') return ''
  return firstNonEmpty(
    stringValue(raw.errorMessage),
    `Prime Agent assistant ${stopReason}`,
  )
}

function assistantText(raw: unknown): string {
  if (!isRecord(raw) || stringValue(raw.role) !== 'assistant') return ''
  if (!Array.isArray(raw.content)) return ''
  const parts: string[] = []
  for (const rawPart of raw.content) {
    if (!isRecord(rawPart) || stringValue(rawPart.type) !== 'text') continue
    const text = stringValue(rawPart.text).trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

const commandPrimeProcess: PrimeProcess = {
  run(req) {
    const { promise, resolve, reject } =
      Promise.withResolvers<PrimeProcessResult>()
    let child: ChildProcess
    try {
      child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return promise
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const abortHandler = () => child.kill()
    req.signal?.addEventListener('abort', abortHandler, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      req.signal?.removeEventListener('abort', abortHandler)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        signal,
      })
    })
    return promise
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * ocpipe Oh My Pi integration.
 *
 * Runs Oh My Pi through its headless JSON print mode.
 */

import { spawn, type ChildProcess } from 'child_process'
import { isAbsolute, join } from 'path'
import { PROJECT_ROOT } from './paths.js'
import type { OmpOptions, RunAgentOptions, RunAgentResult } from './types.js'

interface OmpProcessRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

interface OmpProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface OmpProcess {
  run(req: OmpProcessRequest): Promise<OmpProcessResult>
}

interface OmpRunSummary {
  sawJsonEvent: boolean
  sessionId: string
  finalMessage: string
}

const defaultOmpCommand = 'omp'
const defaultOmpThinking = 'high'
const defaultOmpApprovalMode = 'yolo'

/** runOmpAgent executes an Oh My Pi coding-agent turn. */
export async function runOmpAgent(
  options: RunAgentOptions,
  processRunner: OmpProcess = commandOmpProcess,
): Promise<RunAgentResult> {
  const {
    prompt,
    model,
    sessionId,
    timeoutSec = 3600,
    workdir,
    omp,
    signal,
  } = options

  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const cwd = workdir ?? PROJECT_ROOT
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')
  console.error(
    `\n>>> OMP [${model.modelID}] ${sessionInfo}: ${promptPreview}...`,
  )

  const abort = new AbortController()
  const abortHandler = () => abort.abort()
  signal?.addEventListener('abort', abortHandler, { once: true })
  let timedOut = false
  const timeout =
    timeoutSec > 0 ?
      setTimeout(() => {
        timedOut = true
        abort.abort()
      }, timeoutSec * 1000)
    : null

  try {
    const result = await processRunner.run({
      command: omp?.command ?? defaultOmpCommand,
      args: buildOmpArgs(model.modelID, cwd, sessionId, prompt, omp),
      cwd: omp?.processCwd ?? cwd,
      env: buildOmpEnv(omp),
      signal: abort.signal,
    })
    const summary = parseOmpOutput(result.stdout)
    const detail =
      result.signal ? `signal ${result.signal}` : `status ${result.exitCode}`
    if (result.exitCode !== 0 || result.signal) {
      const message = firstNonEmpty(
        summary.finalMessage,
        result.stderr.trim(),
        result.stdout.trim(),
        detail,
      )
      throw new Error(`OMP exited with ${detail}: ${message}`)
    }

    const response = firstNonEmpty(
      summary.finalMessage,
      summary.sawJsonEvent ? '' : result.stdout.trim(),
    )
    if (!response) {
      throw new Error('OMP returned an empty final message')
    }

    const nextSessionId = firstNonEmpty(summary.sessionId, sessionId ?? '')
    console.error(
      `<<< OMP done (${response.length} chars)${nextSessionId ? ` [session:${nextSessionId}]` : ''}`,
    )
    return {
      text: response,
      sessionId: nextSessionId,
    }
  } catch (err) {
    if (timedOut) {
      throw new Error(`Timeout after ${timeoutSec}s`, { cause: err })
    }
    if (signal?.aborted) {
      throw new Error('Request aborted', { cause: err })
    }
    throw err
  } finally {
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener('abort', abortHandler)
  }
}

function buildOmpArgs(
  modelID: string,
  cwd: string,
  sessionId: string | undefined,
  prompt: string,
  omp: OmpOptions | undefined,
): string[] {
  const args = ['--print', '--mode', 'json', '--cwd', cwd]
  if (modelID) {
    args.push('--model', modelID)
  }
  if (hasOwn(omp, 'codexHome')) {
    args.push('--codex-home', omp?.codexHome ?? '')
  }
  if (sessionId) {
    args.push('--resume', sessionId)
  }
  if (omp?.goalMode || firstNonEmpty(omp?.goalObjective ?? '')) {
    const objective = firstNonEmpty(omp?.goalObjective ?? '', prompt)
    if (objective) {
      args.push('--goal', objective)
    }
  }
  if (
    typeof omp?.contextStopPercent === 'number' &&
    omp.contextStopPercent > 0
  ) {
    args.push('--context-stop-percent', String(omp.contextStopPercent))
  }
  if (typeof omp?.contextStopTokens === 'number' && omp.contextStopTokens > 0) {
    args.push('--context-stop-tokens', String(omp.contextStopTokens))
  }
  if (omp?.scratchHandoffFile) {
    args.push(
      '--scratch-handoff-file',
      resolveOmpPath(cwd, omp.scratchHandoffFile),
    )
  }
  if (omp?.autoApprove ?? true) {
    args.push('--auto-approve')
  }
  const approvalMode = omp?.approvalMode ?? defaultOmpApprovalMode
  if (approvalMode) {
    args.push('--approval-mode', approvalMode)
  }
  const thinking = omp?.thinking ?? defaultOmpThinking
  if (thinking) {
    args.push('--thinking', thinking)
  }
  args.push(...(omp?.extraArgs ?? []))
  if (prompt) {
    args.push('--', prompt)
  }
  return args
}

function buildOmpEnv(omp: OmpOptions | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...omp?.env }
  if (hasOwn(omp, 'codexHome')) {
    delete env.CODEX_HOME
  }
  if (omp?.home) {
    env.OMP_HOME = omp.home
  }
  return env
}

function resolveOmpPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

function parseOmpOutput(stdout: string): OmpRunSummary {
  const summary: OmpRunSummary = {
    sawJsonEvent: false,
    sessionId: '',
    finalMessage: '',
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
    const type = ompString(event.type)
    if (type === 'session') {
      summary.sessionId = firstNonEmpty(
        ompString(event.id),
        ompString(event.sessionId),
        ompString(event.session_id),
        summary.sessionId,
      )
      continue
    }
    if (type === 'message_end') {
      const text = ompAssistantText(event.message)
      if (text) {
        summary.finalMessage = text
      }
    }
  }
  if (!summary.sawJsonEvent) {
    summary.finalMessage = stdout.trim()
  }
  return summary
}

function ompAssistantText(raw: unknown): string {
  if (!isRecord(raw) || ompString(raw.role) !== 'assistant') return ''
  if (Array.isArray(raw.content)) {
    const parts: string[] = []
    for (const rawPart of raw.content) {
      if (!isRecord(rawPart) || ompString(rawPart.type) !== 'text') continue
      const text = ompString(rawPart.text).trim()
      if (text) parts.push(text)
    }
    return parts.join('\n\n')
  }
  return ompString(raw.content).trim()
}

const commandOmpProcess: OmpProcess = {
  run(req) {
    const { promise, resolve, reject } =
      Promise.withResolvers<OmpProcessResult>()
    let child: ChildProcess
    try {
      child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(err)
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

function hasOwn<T extends object, K extends PropertyKey>(
  value: T | undefined,
  key: K,
): value is T & Record<K, unknown> {
  return !!value && Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ompString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

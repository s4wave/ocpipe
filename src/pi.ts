/**
 * ocpipe Pi coding-agent integration.
 *
 * Runs Pi through its JSONL RPC mode.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { homedir } from 'os'
import { PROJECT_ROOT } from './paths.js'
import type { PiOptions, RunAgentOptions, RunAgentResult } from './types.js'

interface PiProcessRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface PiConnection {
  send(line: string): void
  recv(signal?: AbortSignal): Promise<string>
  close(): void
}

export interface PiProcess {
  start(req: PiProcessRequest): PiConnection
}

interface PiRPCState {
  sessionID: string
  modelSummary: string
}

const defaultPiCommand = 'pi'

/** runPiAgent executes a Pi coding-agent turn over JSONL RPC. */
export async function runPiAgent(
  options: RunAgentOptions,
  processRunner: PiProcess = commandPiProcess,
): Promise<RunAgentResult> {
  const {
    prompt,
    model,
    sessionId,
    timeoutSec = 3600,
    workdir,
    pi,
    signal,
  } = options

  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const cwd = workdir ?? PROJECT_ROOT
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')
  console.error(
    `\n>>> Pi [${model.modelID}] ${sessionInfo}: ${promptPreview}...`,
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

  const conn = processRunner.start({
    command: pi?.command ?? defaultPiCommand,
    args: buildPiArgs(model.modelID, sessionId, pi),
    cwd,
    env: buildPiEnv(pi),
  })
  const client = new PiRPCClient(conn)

  try {
    const initial = await client.getState(abort.signal)
    await client.prompt(prompt, abort.signal)
    await client.waitAgentEnd(abort.signal)
    const response = await client.getLastAssistantText(abort.signal)
    const final = await client.getState(abort.signal)
    const nextSessionId = firstNonEmpty(
      final.sessionID,
      initial.sessionID,
      sessionId ?? '',
    )
    if (!nextSessionId) {
      throw new Error('Pi RPC did not emit a provider session ID')
    }
    if (!response) {
      throw new Error('Pi RPC returned an empty final message')
    }
    const modelSummary =
      final.modelSummary ? ` model=${final.modelSummary}` : ''
    console.error(
      `<<< Pi done (${response.length} chars) [session:${nextSessionId}]${modelSummary}`,
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
    conn.close()
  }
}

function buildPiArgs(
  modelID: string,
  sessionId: string | undefined,
  pi: PiOptions | undefined,
): string[] {
  const args = ['--mode', 'rpc', '--approve']
  const sessionDir = piSessionDir(pi)
  if (sessionDir) {
    args.push('--session-dir', sessionDir)
  }
  if (sessionId) {
    args.push('--session-id', sessionId)
  }
  if (modelID) {
    args.push('--model', modelID)
  }
  return args
}

function buildPiEnv(pi: PiOptions | undefined): NodeJS.ProcessEnv {
  const providerHome = piProviderHome(pi)
  const sessionDir = piSessionDir(pi)
  return {
    ...process.env,
    ...pi?.env,
    PI_CODING_AGENT_DIR: providerHome,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...(pi?.baseUrl ? { LLAMA_BASE_URL: pi.baseUrl } : {}),
  }
}

function piProviderHome(pi: PiOptions | undefined): string {
  return pi?.providerHome ?? join(homedir(), '.pi-coding-agent')
}

function piSessionDir(pi: PiOptions | undefined): string {
  return pi?.sessionDir ?? join(piProviderHome(pi), 'sessions')
}

class PiRPCClient {
  private nextID = 0

  constructor(private readonly conn: PiConnection) {}

  async prompt(message: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('prompt', { message }, signal)
    const command = piString(response.command)
    if (command && command !== 'prompt') {
      throw new Error(`Pi RPC command mismatch: expected prompt got ${command}`)
    }
  }

  async getState(signal?: AbortSignal): Promise<PiRPCState> {
    const response = await this.request('get_state', {}, signal)
    const data = piObject(response.data, 'Pi get_state response missing data')
    return {
      sessionID: piString(data.sessionId),
      modelSummary: piModelSummary(data.model),
    }
  }

  async getLastAssistantText(signal?: AbortSignal): Promise<string> {
    const response = await this.request('get_last_assistant_text', {}, signal)
    const data = piObject(
      response.data,
      'Pi get_last_assistant_text response missing data',
    )
    return piString(data.text)
  }

  async waitAgentEnd(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const { value } = await this.recv(signal)
      if (piString(value.type) === 'agent_end') {
        return
      }
    }
  }

  private async request(
    type: string,
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.nextID++
    const id = `ocpipe-pi-${this.nextID}`
    this.conn.send(JSON.stringify({ type, id, ...fields }))
    for (;;) {
      const { value, line } = await this.recv(signal)
      if (piString(value.type) !== 'response' || piString(value.id) !== id) {
        continue
      }
      if (value.success !== true) {
        const errorText = piString(value.error) || line
        throw new Error(`Pi RPC ${type} failed: ${errorText}`)
      }
      return value
    }
  }

  private async recv(
    signal?: AbortSignal,
  ): Promise<{ value: Record<string, unknown>; line: string }> {
    const line = await this.conn.recv(signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw new Error(`Parse Pi RPC JSONL failed: ${line}`, { cause: err })
    }
    return { value: piObject(parsed, 'Pi RPC line must be an object'), line }
  }
}

const commandPiProcess: PiProcess = {
  start(req) {
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    return new CommandPiConnection(child)
  },
}

class CommandPiConnection implements PiConnection {
  private readonly lines: string[] = []
  private readonly waiters: Array<{
    resolve: (line: string) => void
    reject: (err: Error) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []
  private closedError: Error | null = null

  constructor(private readonly child: ChildProcess) {
    if (!child.stdout || !child.stdin) {
      throw new Error('Pi RPC process pipes were not opened')
    }
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => this.push(line))
    child.on('error', (err) => this.closeWith(err))
    child.on('close', (code, signal) => {
      if (this.closedError) return
      if (code === 0) {
        this.closeWith(new Error('Pi RPC closed'))
        return
      }
      const detail = signal ? `signal ${signal}` : `status ${code}`
      this.closeWith(new Error(`Pi RPC exited with ${detail}`))
    })
  }

  send(line: string): void {
    if (!this.child.stdin) {
      throw new Error('Pi RPC stdin is closed')
    }
    this.child.stdin.write(line.trimEnd() + '\n')
  }

  recv(signal?: AbortSignal): Promise<string> {
    if (this.lines.length > 0) {
      return Promise.resolve(this.lines.shift() ?? '')
    }
    if (this.closedError) {
      return Promise.reject(this.closedError)
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Request aborted'))
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: undefined as (() => void) | undefined,
      }
      waiter.abort = () => {
        this.removeWaiter(waiter)
        reject(new Error('Request aborted'))
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.child.stdin?.destroy()
    this.child.kill()
  }

  private push(line: string): void {
    const waiter = this.waiters.shift()
    if (!waiter) {
      this.lines.push(line)
      return
    }
    if (waiter.abort) {
      waiter.signal?.removeEventListener('abort', waiter.abort)
    }
    waiter.resolve(line)
  }

  private closeWith(err: Error): void {
    this.closedError = err
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.abort) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
      }
      waiter.reject(err)
    }
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]): void {
    const idx = this.waiters.indexOf(waiter)
    if (idx >= 0) {
      this.waiters.splice(idx, 1)
    }
  }
}

function piObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function piString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function piModelSummary(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ''
  }
  const model = value as Record<string, unknown>
  const provider = firstNonEmpty(
    piString(model.provider),
    piString(model.providerId),
  )
  const id = firstNonEmpty(
    piString(model.id),
    piString(model.model),
    piString(model.name),
  )
  if (provider && id) {
    return `${provider}/${id}`
  }
  return firstNonEmpty(id, provider)
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

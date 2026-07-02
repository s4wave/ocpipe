/**
 * ocpipe agent integration.
 *
 * Dispatches prompts to configured coding-agent backends.
 */

import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { PROJECT_ROOT, TMP_DIR } from './paths.js'
import type { RunAgentOptions, RunAgentResult } from './types.js'
import { runOmpAgent } from './omp.js'
import { runPiAgent } from './pi.js'

/** runAgent dispatches to the selected backend. */
export async function runAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const backend = options.model.backend ?? 'omp'

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
  const promptFile = join(promptDir, `ocpipe_prompt_${randomUUID()}.txt`)
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
  console.error(`[DEBUG] Running: ${command} ${args.join(' ')}`)
  const proc = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opencode?.env },
  })

  const { promise, resolve, reject } = Promise.withResolvers<RunAgentResult>()
  let newSessionId = sessionId || ''
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let aborted = false

  const abortHandler = () => {
    if (aborted) return
    aborted = true
    console.error(`\n[abort] Killing OpenCode subprocess...`)
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL')
    }, 1000)
    void unlink(promptFile).catch(() => {})
    reject(new Error('Request aborted'))
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString()
    stderrChunks.push(text)

    for (const line of text.split('\n')) {
      if (line.startsWith('[session:')) {
        newSessionId = line.trim().slice(9, -1)
        continue
      }
      if (line.includes('baseline-browser-mapping')) continue
      if (line.startsWith('$ bun run')) continue
      if (line.trim()) {
        process.stderr.write(line + '\n')
      }
    }
  })

  proc.stdout.on('data', (data: Buffer) => {
    const text = data.toString()
    stdoutChunks.push(text)
    process.stderr.write(text)
  })

  const timeout =
    timeoutSec > 0 ?
      setTimeout(() => {
        proc.kill()
        void unlink(promptFile).catch(() => {})
        reject(new Error(`Timeout after ${timeoutSec}s`))
      }, timeoutSec * 1000)
    : undefined

  proc.on('close', async (code) => {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortHandler)
    if (aborted) return

    void unlink(promptFile).catch(() => {})
    const stderr = stderrChunks.join('').trim()

    if (code !== 0) {
      const lastLines = stderr.split('\n').slice(-5).join('\n')
      const detail = lastLines ? `\n${lastLines}` : ''
      reject(new Error(`OpenCode exited with code ${code}${detail}`))
      return
    }

    for (const { pattern, message } of knownOpenCodeErrors) {
      if (pattern.test(stderr)) {
        const errorLines = stderr
          .split('\n')
          .filter(
            (line) =>
              pattern.test(line) ||
              line.includes('Error') ||
              line.includes('error:'),
          )
          .slice(0, 5)
          .join('\n')
        reject(new Error(`OpenCode ${message}:\n${errorLines}`))
        return
      }
    }

    let response = stdoutChunks.join('').trim()
    if (newSessionId) {
      response =
        (await exportSession(newSessionId, cwd, command, opencode?.env)) ??
        response
    }

    if (response.length === 0 && stderr.includes('Error')) {
      const lastLines = stderr.split('\n').slice(-10).join('\n')
      reject(
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
    resolve({ text: response, sessionId: newSessionId })
  })

  proc.on('error', (err) => {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortHandler)
    void unlink(promptFile).catch(() => {})
    reject(err)
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

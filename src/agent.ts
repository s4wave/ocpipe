/**
 * ocpipe OpenCode agent integration.
 *
 * Wraps the OpenCode CLI for running LLM agents with session management.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { PROJECT_ROOT, TMP_DIR } from './paths.js'
import type { RunAgentOptions, RunAgentResult } from './types.js'

/** Find opencode binary from PATH, preferring non-node_modules locations */
function findOpencode(): string | null {
  const pathDirs = (process.env.PATH || '').split(':')

  // First pass: look for opencode in non-node_modules directories
  for (const dir of pathDirs) {
    if (dir.includes('node_modules')) continue
    const candidate = join(dir, 'opencode')
    if (existsSync(candidate)) {
      return candidate
    }
  }

  // Second pass: check node_modules/.bin as fallback
  for (const dir of pathDirs) {
    if (!dir.includes('node_modules')) continue
    const candidate = join(dir, 'opencode')
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

/** Get command and args to invoke opencode */
function getOpencodeCommand(args: string[]): { cmd: string; args: string[] } {
  const opencode = findOpencode()
  if (opencode) {
    return { cmd: opencode, args }
  }
  // Fallback to bunx with ocpipe package (which has opencode-ai as dependency)
  return { cmd: 'bunx', args: ['-p', 'ocpipe', 'opencode', ...args] }
}

/** runAgent executes an OpenCode agent with a prompt, streaming output in real-time. */
export async function runAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const { prompt, agent, model, sessionId, timeoutSec = 300, workdir } = options

  const modelStr = `${model.providerID}/${model.modelID}`
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')

  console.error(
    `\n>>> OpenCode [${agent}] [${modelStr}] ${sessionInfo}: ${promptPreview}...`,
  )

  const args = [
    'run',
    '--format',
    'default',
    '--agent',
    agent,
    '--model',
    modelStr,
  ]

  if (sessionId) {
    args.push('--session', sessionId)
  }

  // Pass prompt as positional argument (stdin doesn't work without TTY)
  args.push(prompt)

  return new Promise((resolve, reject) => {
    const opencodeCmd = getOpencodeCommand(args)
    const proc = spawn(opencodeCmd.cmd, opencodeCmd.args, {
      cwd: workdir ?? PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let newSessionId = sessionId || ''
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    // Stream stderr in real-time (OpenCode progress output)
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)

      // Parse session ID from output
      for (const line of text.split('\n')) {
        if (line.startsWith('[session:')) {
          newSessionId = line.trim().slice(9, -1)
          continue
        }
        // Filter noise
        if (line.includes('baseline-browser-mapping')) continue
        if (line.startsWith('$ bun run')) continue
        if (line.trim()) {
          process.stderr.write(line + '\n')
        }
      }
    })

    // Collect stdout
    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
      process.stderr.write(text)
    })

    // Timeout handling (0 = no timeout)
    const timeout =
      timeoutSec > 0 ?
        setTimeout(() => {
          proc.kill()
          reject(new Error(`Timeout after ${timeoutSec}s`))
        }, timeoutSec * 1000)
      : null

    proc.on('close', async (code) => {
      if (timeout) clearTimeout(timeout)

      if (code !== 0) {
        const stderr = stderrChunks.join('').trim()
        const lastLines = stderr.split('\n').slice(-5).join('\n')
        const detail = lastLines ? `\n${lastLines}` : ''
        reject(new Error(`OpenCode exited with code ${code}${detail}`))
        return
      }

      // Export session to get structured response
      let response = stdoutChunks.join('').trim()

      if (newSessionId) {
        const exported = await exportSession(newSessionId, workdir)
        if (exported) {
          response = exported
        }
      }

      const sessionStr = newSessionId || 'none'
      console.error(
        `<<< OpenCode done (${response.length} chars) [session:${sessionStr}]`,
      )

      resolve({
        text: response,
        sessionId: newSessionId,
      })
    })

    proc.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      reject(err)
    })
  })
}

/** exportSession exports a session and extracts assistant text responses. */
async function exportSession(
  sessionId: string,
  workdir?: string,
): Promise<string | null> {
  const tmpPath = `${TMP_DIR}/opencode_export_${Date.now()}.json`

  try {
    await mkdir(TMP_DIR, { recursive: true })
    const opencodeCmd = getOpencodeCommand([
      'session',
      'export',
      sessionId,
      '--format',
      'json',
      '-o',
      tmpPath,
    ])
    const proc = Bun.spawn([opencodeCmd.cmd, ...opencodeCmd.args], {
      cwd: workdir ?? PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await proc.exited

    const file = Bun.file(tmpPath)
    if (!(await file.exists())) return null

    const data = (await file.json()) as {
      messages?: Array<{
        info?: { role?: string }
        parts?: Array<{ type?: string; text?: string }>
      }>
    }
    await Bun.write(tmpPath, '') // Clean up

    // Extract all assistant text parts
    const messages = data.messages || []
    const textParts: string[] = []

    for (const msg of messages) {
      if (msg.info?.role === 'assistant') {
        for (const part of msg.parts || []) {
          if (part.type === 'text' && part.text) {
            textParts.push(part.text)
          }
        }
      }
    }

    return textParts.length > 0 ? textParts.join('\n') : null
  } catch {
    return null
  }
}

/** logStep logs a step header for workflow progress. */
export function logStep(step: number, title: string, detail = ''): void {
  const detailStr = detail ? ` (${detail})` : ''
  console.log(`\n${'='.repeat(60)}`)
  console.log(`STEP ${step}: ${title}${detailStr}`)
  console.log('='.repeat(60))
}

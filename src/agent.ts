/**
 * ocpipe agent integration.
 *
 * Dispatches to OpenCode CLI or Claude Code SDK based on backend configuration.
 */

import { spawn } from 'child_process'
import { mkdir, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { PROJECT_ROOT, TMP_DIR } from './paths.js'
import type { RunAgentOptions, RunAgentResult } from './types.js'

/** Get command and args to invoke opencode from PATH */
function getOpencodeCommand(args: string[]): { cmd: string; args: string[] } {
  return { cmd: 'opencode', args }
}

/** runAgent dispatches to the appropriate backend based on model configuration. */
export async function runAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const backend = options.model.backend ?? 'opencode'

  if (backend === 'claude-code') {
    // Dynamic import to avoid requiring @anthropic-ai/claude-agent-sdk when using opencode
    const { runClaudeCodeAgent } = await import('./claude-code.js')
    return runClaudeCodeAgent(options)
  }

  return runOpencodeAgent(options)
}

/** runOpencodeAgent executes an OpenCode agent with a prompt, streaming output in real-time. */
async function runOpencodeAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const { prompt, agent, model, sessionId, timeoutSec = 300, workdir } = options

  const modelStr = `${model.providerID}/${model.modelID}`
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')

  console.error(
    `\n>>> OpenCode [${agent}] [${modelStr}] ${sessionInfo}: ${promptPreview}...`,
  )

  // Write prompt to .opencode/prompts/ within the working directory
  const cwd = workdir ?? PROJECT_ROOT
  const promptsDir = join(cwd, '.opencode', 'prompts')
  await mkdir(promptsDir, { recursive: true })
  const promptFile = join(promptsDir, `prompt_${Date.now()}.txt`)
  await writeFile(promptFile, prompt)

  const args = [
    'run',
    '--format',
    'default',
    '--agent',
    agent,
    '--model',
    modelStr,
    '--prompt-file',
    promptFile,
  ]

  if (sessionId) {
    args.push('--session', sessionId)
  }

  return new Promise((resolve, reject) => {
    const opencodeCmd = getOpencodeCommand(args)
    const proc = spawn(opencodeCmd.cmd, opencodeCmd.args, {
      cwd,
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
        setTimeout(async () => {
          proc.kill()
          await unlink(promptFile).catch(() => {})
          reject(new Error(`Timeout after ${timeoutSec}s`))
        }, timeoutSec * 1000)
      : null

    proc.on('close', async (code) => {
      if (timeout) clearTimeout(timeout)

      // Clean up prompt file
      await unlink(promptFile).catch(() => {})

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

    proc.on('error', async (err) => {
      if (timeout) clearTimeout(timeout)
      await unlink(promptFile).catch(() => {})
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

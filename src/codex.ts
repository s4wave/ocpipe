/**
 * ocpipe Codex CLI integration.
 *
 * Runs Codex non-interactively through `codex exec`.
 */

import { spawn } from 'child_process'
import { mkdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { PROJECT_ROOT, TMP_DIR } from './paths.js'
import type { RunAgentOptions, RunAgentResult } from './types.js'

class CodexLogFilter {
  private buf = ''
  private suppressHtml = false

  write(text: string): string {
    this.buf += text
    let out = ''
    for (;;) {
      const idx = this.buf.indexOf('\n')
      if (idx < 0) {
        return out
      }
      const line = this.buf.slice(0, idx + 1)
      this.buf = this.buf.slice(idx + 1)
      out += this.filterLine(line)
    }
  }

  flush(): string {
    const line = this.buf
    this.buf = ''
    return this.filterLine(line)
  }

  private filterLine(line: string): string {
    if (this.suppressHtml) {
      if (line.includes('</html>')) {
        this.suppressHtml = false
      }
      return ''
    }
    if (suppressCodexLogLine(line)) {
      return ''
    }
    if (suppressCodexHtmlLine(line)) {
      this.suppressHtml = !line.includes('</html>')
      return ''
    }
    return line
  }
}

export function filterCodexLogText(text: string): string {
  const filter = new CodexLogFilter()
  return filter.write(text) + filter.flush()
}

function suppressCodexLogLine(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+WARN\s+codex_/.test(line)
}

function suppressCodexHtmlLine(line: string): boolean {
  return /^\s*(<!doctype html>|<html\b|<head\b)/i.test(line)
}

/** runCodexAgent executes a Codex agent with a prompt. */
export async function runCodexAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const {
    prompt,
    model,
    sessionId,
    timeoutSec = 3600,
    workdir,
    codex,
    signal,
  } = options

  if (sessionId) {
    throw new Error('Codex backend does not support session resume yet')
  }
  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const cwd = workdir ?? PROJECT_ROOT
  await mkdir(TMP_DIR, { recursive: true })
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const outputFile = join(TMP_DIR, `codex_output_${stamp}.txt`)

  const cmd = codex?.pathToCodexExecutable ?? 'codex'
  const args = [
    'exec',
    '--color',
    'never',
    '--model',
    model.modelID,
    '--sandbox',
    codex?.sandbox ?? 'read-only',
    '--cd',
    cwd,
    '--output-last-message',
    outputFile,
  ]

  if (codex?.ephemeral ?? true) {
    args.push('--ephemeral')
  }
  if (codex?.ignoreUserConfig) {
    args.push('--ignore-user-config')
  }
  if (codex?.ignoreRules) {
    args.push('--ignore-rules')
  }
  if (codex?.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${codex.reasoningEffort}"`)
  }
  for (const dir of codex?.addDirs ?? []) {
    args.push('--add-dir', dir)
  }
  for (const [key, value] of Object.entries(codex?.config ?? {})) {
    args.push('-c', `${key}=${value}`)
  }
  args.push('-')

  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')
  console.error(
    `\n>>> Codex [${model.modelID}] [new session]: ${promptPreview}...`,
  )

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stderrChunks: string[] = []
    const stdoutFilter = new CodexLogFilter()
    const stderrFilter = new CodexLogFilter()
    let aborted = false

    const cleanup = async () => {
      await unlink(outputFile).catch(() => {})
    }

    const abortHandler = () => {
      if (aborted) return
      aborted = true
      console.error('\n[abort] Killing Codex subprocess...')
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
      }, 1000)
      void cleanup()
      reject(new Error('Request aborted'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })

    proc.stdout.on('data', (data: Buffer) => {
      const text = stdoutFilter.write(data.toString())
      if (text) {
        process.stderr.write(text)
      }
    })
    proc.stderr.on('data', (data: Buffer) => {
      const text = stderrFilter.write(data.toString())
      stderrChunks.push(text)
      if (text) {
        process.stderr.write(text)
      }
    })

    const timeout =
      timeoutSec > 0 ?
        setTimeout(() => {
          proc.kill()
          void cleanup()
          reject(new Error(`Timeout after ${timeoutSec}s`))
        }, timeoutSec * 1000)
      : null

    proc.stdin.end(prompt)

    proc.on('close', async (code) => {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', abortHandler)
      if (aborted) return

      const stdoutTail = stdoutFilter.flush()
      if (stdoutTail) {
        process.stderr.write(stdoutTail)
      }
      const stderrTail = stderrFilter.flush()
      if (stderrTail) {
        stderrChunks.push(stderrTail)
        process.stderr.write(stderrTail)
      }
      const stderr = stderrChunks.join('').trim()
      if (code !== 0) {
        await cleanup()
        const detail =
          stderr ? `\n${stderr.split('\n').slice(-10).join('\n')}` : ''
        reject(new Error(`Codex exited with code ${code}${detail}`))
        return
      }

      try {
        const response = (await readFile(outputFile, 'utf8')).trim()
        await cleanup()
        if (!response) {
          reject(new Error('Codex returned an empty response'))
          return
        }
        console.error(`<<< Codex done (${response.length} chars)`)
        resolve({
          text: response,
          sessionId: '',
        })
      } catch (err) {
        await cleanup()
        reject(err)
      }
    })

    proc.on('error', async (err) => {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', abortHandler)
      await cleanup()
      reject(err)
    })
  })
}

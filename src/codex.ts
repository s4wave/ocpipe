/**
 * ocpipe Codex SDK integration.
 *
 * Runs Codex through @openai/codex-sdk threads.
 */

import {
  Codex,
  type CodexOptions as CodexSdkClientOptions,
  type ThreadOptions,
} from '@openai/codex-sdk'
import { PROJECT_ROOT } from './paths.js'
import type { CodexOptions, RunAgentOptions, RunAgentResult } from './types.js'

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

  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const cwd = workdir ?? PROJECT_ROOT
  const client = new Codex(buildCodexClientOptions(codex))
  const threadOptions = buildCodexThreadOptions(model.modelID, cwd, codex)
  const thread =
    sessionId && !codex?.ephemeral ?
      client.resumeThread(sessionId, threadOptions)
    : client.startThread(threadOptions)

  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')
  const sessionInfo =
    sessionId && !codex?.ephemeral ? `[thread:${sessionId}]` : '[new thread]'
  console.error(
    `\n>>> Codex SDK [${model.modelID}] ${sessionInfo}: ${promptPreview}...`,
  )

  const abort = new AbortController()
  let timedOut = false
  const abortHandler = () => abort.abort()
  signal?.addEventListener('abort', abortHandler, { once: true })
  const timeout =
    timeoutSec > 0 ?
      setTimeout(() => {
        timedOut = true
        abort.abort()
      }, timeoutSec * 1000)
    : null

  try {
    const result = await thread.run(prompt, { signal: abort.signal })
    const response = result.finalResponse.trim()
    if (!response) {
      throw new Error('Codex returned an empty response')
    }

    const nextSessionId = codex?.ephemeral ? '' : (thread.id ?? '')
    const sessionStr = nextSessionId || 'none'
    console.error(
      `<<< Codex SDK done (${response.length} chars) [thread:${sessionStr}]`,
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

function buildCodexClientOptions(
  codex: CodexOptions | undefined,
): CodexSdkClientOptions {
  return {
    ...(codex?.pathToCodexExecutable ?
      { codexPathOverride: codex.pathToCodexExecutable }
    : {}),
    ...(codex?.baseUrl ? { baseUrl: codex.baseUrl } : {}),
    ...(codex?.apiKey ? { apiKey: codex.apiKey } : {}),
    ...(codex?.env ? { env: codex.env } : {}),
    ...(codex?.config ? { config: codex.config } : {}),
  }
}

function buildCodexThreadOptions(
  modelID: string,
  cwd: string,
  codex: CodexOptions | undefined,
): ThreadOptions {
  return {
    model: modelID,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: codex?.sandbox ?? 'read-only',
    ...(codex?.reasoningEffort ?
      { modelReasoningEffort: codex.reasoningEffort }
    : {}),
    ...(codex?.addDirs ? { additionalDirectories: codex.addDirs } : {}),
    ...(codex?.approvalPolicy ? { approvalPolicy: codex.approvalPolicy } : {}),
    ...(codex?.networkAccessEnabled !== undefined ?
      { networkAccessEnabled: codex.networkAccessEnabled }
    : {}),
    ...(codex?.webSearchMode ? { webSearchMode: codex.webSearchMode } : {}),
    ...(codex?.webSearchEnabled !== undefined ?
      { webSearchEnabled: codex.webSearchEnabled }
    : {}),
  }
}

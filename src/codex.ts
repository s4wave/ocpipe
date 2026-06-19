/**
 * ocpipe Codex SDK integration.
 *
 * Runs Codex through @openai/codex-sdk threads.
 */

import {
  Codex,
  type CodexOptions as CodexSdkClientOptions,
  type RunResult,
  type ThreadOptions,
} from '@openai/codex-sdk'
import { PROJECT_ROOT } from './paths.js'
import type {
  CodexOptions,
  CodexRunSummary,
  RunAgentOptions,
  RunAgentResult,
} from './types.js'

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
    const runSummary = buildCodexRunSummary(result)
    console.error(
      `<<< Codex SDK done [thread:${sessionStr}]\n${formatCodexRunSummary(runSummary)}`,
    )

    return {
      text: response,
      sessionId: nextSessionId,
      runSummary,
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

/** buildCodexRunSummary projects a Codex turn into a parent-readable summary. */
export function buildCodexRunSummary(result: RunResult): CodexRunSummary {
  const commands: CodexRunSummary['commands'] = []
  const fileChanges: CodexRunSummary['fileChanges'] = []
  let errorMessage = ''
  let finalMessage = result.finalResponse.trim()

  for (const item of result.items) {
    switch (item.type) {
      case 'agent_message':
        if (item.text) finalMessage = item.text
        break
      case 'command_execution':
        commands.push({
          command: item.command,
          status: item.status,
          exitCode: item.exit_code ?? null,
        })
        break
      case 'file_change':
        for (const change of item.changes) {
          fileChanges.push({
            path: change.path,
            kind: change.kind,
            status: item.status,
          })
        }
        break
      case 'error':
        errorMessage = item.message
        break
    }
  }

  const usage = result.usage
  return {
    status: errorMessage ? 'failed' : 'completed',
    finalMessage: finalMessage.trim(),
    errorMessage,
    commands,
    fileChanges,
    tokens:
      usage ?
        {
          input: usage.input_tokens,
          cached: usage.cached_input_tokens,
          output: usage.output_tokens,
          reasoning: usage.reasoning_output_tokens,
        }
      : null,
  }
}

/** formatCodexRunSummary renders a Codex run summary as a clean text block. */
export function formatCodexRunSummary(summary: CodexRunSummary): string {
  const lines: string[] = [`status: ${summary.status}`]
  if (summary.errorMessage) {
    lines.push(`error: ${summary.errorMessage}`)
  }
  if (summary.commands.length > 0) {
    const failed = summary.commands.filter(isFailedCommand).length
    lines.push(
      `commands: ${summary.commands.length} completed, ${failed} failed`,
    )
  }
  if (summary.fileChanges.length > 0) {
    let add = 0
    let update = 0
    let del = 0
    for (const change of summary.fileChanges) {
      if (change.kind === 'add') add++
      else if (change.kind === 'delete') del++
      else update++
    }
    lines.push(`files: add=${add} update=${update} delete=${del}`)
  }
  if (summary.tokens) {
    const t = summary.tokens
    lines.push(
      `tokens: input=${t.input} cached=${t.cached} output=${t.output} reasoning=${t.reasoning}`,
    )
  }
  if (summary.finalMessage) {
    lines.push(`final_message:\n${summary.finalMessage}`)
  }
  return lines.join('\n')
}

function isFailedCommand(command: CodexRunSummary['commands'][number]): boolean {
  return (
    command.status === 'failed' ||
    (command.exitCode !== null && command.exitCode !== 0)
  )
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

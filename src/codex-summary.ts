import type { CodexRunResult, CodexRunSummary } from './types.js'

/** buildCodexRunSummary projects a Codex turn into a parent-readable summary. */
export function buildCodexRunSummary(result: CodexRunResult): CodexRunSummary {
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
        if (
          typeof item.command === 'string' &&
          typeof item.status === 'string'
        ) {
          commands.push({
            command: item.command,
            status: item.status,
            exitCode: item.exit_code ?? null,
          })
        }
        break
      case 'file_change':
        if (item.changes && typeof item.status === 'string') {
          for (const change of item.changes) {
            fileChanges.push({
              path: change.path,
              kind: change.kind,
              status: item.status,
            })
          }
        }
        break
      case 'error':
        if (typeof item.message === 'string') errorMessage = item.message
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
    tokens: usage
      ? {
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

function isFailedCommand(
  command: CodexRunSummary['commands'][number],
): boolean {
  return (
    command.status === 'failed' ||
    (command.exitCode !== null && command.exitCode !== 0)
  )
}

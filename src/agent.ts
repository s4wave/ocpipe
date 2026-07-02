/**
 * ocpipe agent integration.
 *
 * Dispatches prompts to configured coding-agent backends.
 */

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

  if (backend === 'pi') {
    return runPiAgent(options)
  }

  if (backend === 'omp') {
    return runOmpAgent(options)
  }

  const unreachable: never = backend
  throw new Error(`Unsupported backend: ${unreachable}`)
}

/** logStep logs a step header for workflow progress. */
export function logStep(step: number, title: string, detail = ''): void {
  const detailStr = detail ? ` (${detail})` : ''
  console.log(`\n${'='.repeat(60)}`)
  console.log(`STEP ${step}: ${title}${detailStr}`)
  console.log('='.repeat(60))
}

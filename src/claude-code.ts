/**
 * ocpipe Claude Code agent integration.
 *
 * Uses the Claude Agent SDK v2 for running LLM agents with session management.
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { RunAgentOptions, RunAgentResult } from './types.js'

/** Normalize model ID to Claude Code format (opus, sonnet, haiku). */
function normalizeModelId(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return modelId
}

/** Extract text from assistant messages. */
function getAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  const textParts: string[] = []
  for (const block of msg.message.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    }
  }
  return textParts.join('')
}

/** runClaudeCodeAgent executes a Claude Code agent with a prompt. */
export async function runClaudeCodeAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const { prompt, model, sessionId, timeoutSec = 300 } = options

  // Claude Code understands simple names: opus, sonnet, haiku
  const modelStr = normalizeModelId(model.modelID)
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')

  console.error(
    `\n>>> Claude Code [${modelStr}] ${sessionInfo}: ${promptPreview}...`,
  )

  // Create or resume session
  const session =
    sessionId ?
      unstable_v2_resumeSession(sessionId, { model: modelStr })
    : unstable_v2_createSession({ model: modelStr })

  try {
    // Send the prompt
    await session.send(prompt)

    // Collect the response
    const textParts: string[] = []
    let newSessionId = sessionId || ''

    // Set up timeout
    const timeoutPromise =
      timeoutSec > 0 ?
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            session.close()
            reject(new Error(`Timeout after ${timeoutSec}s`))
          }, timeoutSec * 1000)
        })
      : null

    // Stream the response
    const streamPromise = (async () => {
      for await (const msg of session.stream()) {
        // Capture session ID from any message
        if (msg.session_id) {
          newSessionId = msg.session_id
        }

        const text = getAssistantText(msg)
        if (text) {
          textParts.push(text)
          process.stderr.write(text)
        }
      }
    })()

    // Race between stream and timeout
    if (timeoutPromise) {
      await Promise.race([streamPromise, timeoutPromise])
    } else {
      await streamPromise
    }

    const response = textParts.join('')
    const sessionStr = newSessionId || 'none'
    console.error(
      `\n<<< Claude Code done (${response.length} chars) [session:${sessionStr}]`,
    )

    return {
      text: response,
      sessionId: newSessionId,
    }
  } finally {
    session.close()
  }
}

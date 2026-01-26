/**
 * ocpipe Claude Code agent integration.
 *
 * Uses the Claude Agent SDK v2 for running LLM agents with session management.
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type HookCallback,
  type PreToolUseHookInput,
  type SDKMessage,
  type SDKSessionOptions,
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

/** logToolCall logs tool calls in a compact format during execution. */
const logToolCall: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput
  const name = preInput.tool_name
  const toolInput = preInput.tool_input as Record<string, unknown>

  if (name === 'Bash') {
    const cmd = toolInput?.command as string
    const preview = cmd?.split('\n')[0]?.slice(0, 80)
    console.error(`\n[Bash] ${preview}${cmd?.length > 80 ? '...' : ''}`)
  } else if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const path = toolInput?.file_path as string
    console.error(`\n[${name}] ${path}`)
  } else if (name === 'Glob' || name === 'Grep') {
    const pattern = toolInput?.pattern as string
    console.error(`\n[${name}] ${pattern}`)
  } else {
    console.error(`\n[${name}]`)
  }

  return {}
}

/** runClaudeCodeAgent executes a Claude Code agent with a prompt. */
export async function runClaudeCodeAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const { prompt, model, sessionId, timeoutSec = 600, claudeCode, signal } = options

  // Check if already aborted
  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  // Claude Code understands simple names: opus, sonnet, haiku
  const modelStr = normalizeModelId(model.modelID)
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')

  // Build session options with configurable permission mode (default: acceptEdits)
  const permissionMode = claudeCode?.permissionMode ?? 'acceptEdits'
  const sessionOptions: SDKSessionOptions = {
    model: modelStr,
    permissionMode,
    hooks: {
      PreToolUse: [{ hooks: [logToolCall] }],
    },
    // bypassPermissions requires explicit opt-in
    ...(permissionMode === 'bypassPermissions' &&
      claudeCode?.dangerouslySkipPermissions && {
        allowDangerouslySkipPermissions: true,
      }),
  }

  console.error(
    `\n>>> Claude Code [${modelStr}] [${permissionMode}] ${sessionInfo}: ${promptPreview}...`,
  )

  // Create or resume session
  const session =
    sessionId ?
      unstable_v2_resumeSession(sessionId, sessionOptions)
    : unstable_v2_createSession(sessionOptions)

  // Handle abort signal
  const abortHandler = () => {
    console.error(`\n[abort] Closing Claude Code session...`)
    session.close()
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

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

    // Set up abort promise
    const abortPromise = signal ?
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('Request aborted'))
        }, { once: true })
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

    // Race between stream, timeout, and abort
    const promises: Promise<void | never>[] = [streamPromise]
    if (timeoutPromise) promises.push(timeoutPromise)
    if (abortPromise) promises.push(abortPromise)
    await Promise.race(promises)

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
    signal?.removeEventListener('abort', abortHandler)
    session.close()
  }
}

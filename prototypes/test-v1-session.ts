#!/usr/bin/env bun
/**
 * Prototype: Test Claude Agent SDK v1 query() API for session persistence.
 *
 * The v1 API uses query() which returns an AsyncGenerator. The subprocess exits
 * naturally when the generator completes, giving it time to persist session data.
 *
 * See: https://github.com/s4wave/ocpipe/issues/10
 * See: https://github.com/anthropics/anthropic-sdk-typescript/issues/911
 *
 * Test flow:
 *   1. Send a first query, capture session_id
 *   2. Resume the session with a follow-up query referencing the first
 *   3. Check if the resumed session has context from the first query
 *
 * Usage: bun run prototypes/test-v1-session.ts
 */

import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'

const MODEL = 'haiku'
const PERMISSION_MODE = 'plan' // plan mode = no tool execution, safe for testing

/** Extract text from an assistant message. */
function getAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  const parts: string[] = []
  for (const block of (msg as SDKAssistantMessage).message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('')
}

/** Build a clean env without CLAUDECODE to avoid nested-session detection. */
function cleanEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.CLAUDECODE
  return env
}

/** Run a single query and return { text, sessionId, resultMsg }. */
async function runQuery(
  prompt: string,
  sessionId?: string,
): Promise<{ text: string; sessionId: string; resultMsg?: SDKResultMessage }> {
  const options: Options = {
    model: MODEL,
    permissionMode: PERMISSION_MODE,
    persistSession: true,
    env: cleanEnv(),
    stderr: (data: string) => process.stderr.write(`[stderr] ${data}`),
    ...(sessionId && { resume: sessionId }),
  }

  console.log(`\n--- v1 query() ${sessionId ? `[resume:${sessionId}]` : '[new]'} ---`)
  console.log(`Prompt: ${prompt}`)

  const q = query({ prompt, options })

  const textParts: string[] = []
  let capturedSessionId = sessionId || ''
  let resultMsg: SDKResultMessage | undefined

  for await (const msg of q) {
    if (msg.session_id) {
      capturedSessionId = msg.session_id
    }

    const text = getAssistantText(msg)
    if (text) {
      textParts.push(text)
    }

    if (msg.type === 'result') {
      resultMsg = msg as SDKResultMessage
    }
  }

  const fullText = textParts.join('')
  console.log(`Response (${fullText.length} chars): ${fullText.slice(0, 200)}...`)
  console.log(`Session ID: ${capturedSessionId}`)
  if (resultMsg) {
    console.log(`Result subtype: ${resultMsg.subtype}`)
    if (resultMsg.subtype === 'success') {
      console.log(`Cost: $${resultMsg.total_cost_usd.toFixed(4)}`)
    }
  }

  return { text: fullText, sessionId: capturedSessionId, resultMsg }
}

// --- Main ---
async function main() {
  console.log('=== v1 query() API — Session Persistence Test ===')
  console.log(`Model: ${MODEL}, Permission mode: ${PERMISSION_MODE}`)

  // Step 1: First query — establish session with a memorable fact
  const first = await runQuery(
    'Remember this secret code: PINEAPPLE-42. Just acknowledge you received it and repeat the code back.',
  )

  if (!first.sessionId) {
    console.error('\nFAIL: No session ID captured from first query')
    process.exit(1)
  }

  console.log(`\n>>> Captured session ID: ${first.sessionId}`)
  console.log('>>> Waiting 3 seconds before resuming...')
  await new Promise((r) => setTimeout(r, 3000))

  // Step 2: Resume session — ask about the secret code
  const second = await runQuery(
    'What was the secret code I told you earlier? Please repeat it.',
    first.sessionId,
  )

  // Step 3: Check if context was preserved
  console.log('\n=== RESULTS ===')
  const hasContext = second.text.includes('PINEAPPLE') || second.text.includes('42')
  console.log(`Session persisted: ${hasContext ? 'YES' : 'NO'}`)
  console.log(`Session ID match: ${second.sessionId === first.sessionId ? 'SAME' : 'DIFFERENT'}`)

  if (!hasContext) {
    console.log('\nWARN: The resumed session did NOT recall the secret code.')
    console.log('This suggests session persistence may not be working.')
  } else {
    console.log('\nSUCCESS: The resumed session recalled the secret code!')
    console.log('v1 query() API session persistence is working.')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

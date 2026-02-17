#!/usr/bin/env bun
/**
 * Prototype: Test Claude Agent SDK v2 session API for session persistence.
 *
 * The v2 API uses unstable_v2_createSession / unstable_v2_resumeSession.
 * session.close() sends SIGTERM to the subprocess — the concern is that this
 * may kill the process before it can persist session data to disk.
 *
 * See: https://github.com/s4wave/ocpipe/issues/10
 * See: https://github.com/anthropics/claude-agent-sdk-typescript/issues/177
 *
 * Test flow:
 *   1. Create a session, send a prompt, stream the response, close()
 *   2. Resume the session with unstable_v2_resumeSession()
 *   3. Check if the resumed session has context from the first interaction
 *
 * Usage: bun run prototypes/test-v2-session.ts
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKSessionOptions,
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

const sessionOptions: SDKSessionOptions = {
  model: MODEL,
  permissionMode: PERMISSION_MODE,
  env: cleanEnv(),
  // v2 defaults persistSession to false — we must explicitly set it
  // (Note: SDKSessionOptions may not have this field; we spread it in to test)
  ...({ persistSession: true } as Record<string, unknown>),
}

/** Send a prompt to a session, stream the response, and return text + result. */
async function sendAndStream(
  session: ReturnType<typeof unstable_v2_createSession>,
  prompt: string,
  label: string,
): Promise<{ text: string; sessionId: string; resultMsg?: SDKResultMessage }> {
  console.log(`\n--- v2 ${label} ---`)
  console.log(`Prompt: ${prompt}`)

  await session.send(prompt)

  const textParts: string[] = []
  let capturedSessionId = ''
  let resultMsg: SDKResultMessage | undefined

  for await (const msg of session.stream()) {
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
  console.log('=== v2 Session API — Session Persistence Test ===')
  console.log(`Model: ${MODEL}, Permission mode: ${PERMISSION_MODE}`)

  // Step 1: Create session, send first prompt
  const session1 = unstable_v2_createSession(sessionOptions)

  const first = await sendAndStream(
    session1,
    'Remember this secret code: PINEAPPLE-42. Just acknowledge you received it and repeat the code back.',
    'createSession [new]',
  )

  const sessionId = first.sessionId
  if (!sessionId) {
    console.error('\nFAIL: No session ID captured from first query')
    session1.close()
    process.exit(1)
  }

  console.log(`\n>>> Captured session ID: ${sessionId}`)
  console.log('>>> Closing session (session.close())...')
  session1.close()

  console.log('>>> Waiting 3 seconds before resuming...')
  await new Promise((r) => setTimeout(r, 3000))

  // Step 2: Resume session
  console.log(`>>> Resuming session ${sessionId}...`)
  let session2: ReturnType<typeof unstable_v2_resumeSession>
  try {
    session2 = unstable_v2_resumeSession(sessionId, sessionOptions)
  } catch (err) {
    console.error(`\nFAIL: Could not resume session: ${err}`)
    console.log('This confirms the v2 API issue — close() killed the subprocess before persisting.')
    process.exit(1)
  }

  let second: { text: string; sessionId: string; resultMsg?: SDKResultMessage }
  try {
    second = await sendAndStream(
      session2,
      'What was the secret code I told you earlier? Please repeat it.',
      `resumeSession [${sessionId}]`,
    )
  } catch (err) {
    console.error(`\nFAIL: Error during resumed session: ${err}`)
    console.log('The resumed session failed — session data may not have been persisted.')
    session2.close()
    process.exit(1)
  }

  session2.close()

  // Step 3: Check if context was preserved
  console.log('\n=== RESULTS ===')
  const hasContext = second.text.includes('PINEAPPLE') || second.text.includes('42')
  console.log(`Session persisted: ${hasContext ? 'YES' : 'NO'}`)
  console.log(`Session ID match: ${second.sessionId === sessionId ? 'SAME' : 'DIFFERENT'}`)

  if (!hasContext) {
    console.log('\nWARN: The resumed session did NOT recall the secret code.')
    console.log('This confirms the v2 API session persistence issue.')
    console.log('close() likely sends SIGTERM before the subprocess can persist session data.')
  } else {
    console.log('\nSUCCESS: The resumed session recalled the secret code!')
    console.log('v2 session API persistence is working (possibly with the persistSession flag).')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

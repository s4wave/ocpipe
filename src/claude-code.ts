/**
 * ocpipe Claude Code agent integration.
 *
 * Uses the Claude Agent SDK v1 query() API for running LLM agents with session management.
 * The v1 API properly supports session persistence — the subprocess exits naturally when
 * the query completes, giving it time to save session data to disk. The v2 API's close()
 * sends SIGTERM immediately, which kills the subprocess before it can persist.
 *
 * See: https://github.com/s4wave/ocpipe/issues/10
 * See: https://github.com/anthropics/claude-agent-sdk-typescript/issues/177
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  query,
  type HookCallback,
  type Options,
  type PreToolUseHookInput,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { RunAgentOptions, RunAgentResult } from './types.js'

/** ANSI color codes for terminal output. */
const Style = {
  TEXT_HIGHLIGHT_BOLD: '\x1b[96m\x1b[1m', // Cyan (Read)
  TEXT_DIM: '\x1b[90m', // Gray (dimmed type text)
  TEXT_NORMAL: '\x1b[0m', // Reset
  TEXT_DANGER_BOLD: '\x1b[91m\x1b[1m', // Red (Bash)
  TEXT_SUCCESS_BOLD: '\x1b[92m\x1b[1m', // Green (Edit, Write)
  TEXT_INFO_BOLD: '\x1b[94m\x1b[1m', // Blue (Glob, Grep)
}

/** Map tool names to their display colors. */
const TOOL_COLORS: Record<string, string> = {
  Bash: Style.TEXT_DANGER_BOLD,
  Edit: Style.TEXT_SUCCESS_BOLD,
  Write: Style.TEXT_SUCCESS_BOLD,
  Read: Style.TEXT_HIGHLIGHT_BOLD,
  Glob: Style.TEXT_INFO_BOLD,
  Grep: Style.TEXT_INFO_BOLD,
}

/** Track whether the last stderr write ended with a newline. */
let lastOutputEndedWithNewline = true

/** Print a tool event with colored pipe prefix. */
function printToolEvent(color: string, type: string, title: string): void {
  if (!lastOutputEndedWithNewline) {
    process.stderr.write('\n')
  }
  const line = [
    color + '|',
    Style.TEXT_NORMAL + Style.TEXT_DIM + ` ${type.padEnd(7)}`,
    '',
    Style.TEXT_NORMAL + title,
  ].join(' ')
  console.error(line)
}

/** Resolve the Claude Code executable path.
 * Priority: 1) explicit option, 2) `which claude` from PATH, 3) common default paths. */
function resolveClaudeCodePath(explicit?: string): string | undefined {
  if (explicit) return explicit

  try {
    const found = execSync('which claude', { encoding: 'utf8', timeout: 3000 }).trim()
    if (found) return found
  } catch { /* which not found or timed out — fall through to defaults */ }

  const defaults = [
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ]
  for (const p of defaults) {
    if (existsSync(p)) return p
  }

  return undefined
}

/** Normalize model ID to Claude Code format (opus, sonnet, haiku). */
function normalizeModelId(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return modelId
}

/** loadAgentDefinition loads an OpenCode agent definition file and extracts the
 * markdown body (stripping the YAML frontmatter) for use as a system prompt. */
function loadAgentDefinition(agent: string, workdir?: string): string | undefined {
  if (!agent || !workdir) return undefined

  const agentPath = join(workdir, '.opencode', 'agents', `${agent}.md`)
  if (!existsSync(agentPath)) return undefined

  const content = readFileSync(agentPath, 'utf8')

  // Strip YAML frontmatter (--- delimited block at the start).
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '')
  return stripped.trim() || undefined
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
  const color = TOOL_COLORS[name] ?? Style.TEXT_DIM

  if (name === 'Bash') {
    const cmd = toolInput?.command as string
    const preview = cmd?.split('\n')[0]?.slice(0, 80)
    printToolEvent(color, name, preview + (cmd?.length > 80 ? '...' : ''))
  } else if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const path = toolInput?.file_path as string
    printToolEvent(color, name, path)
  } else if (name === 'Glob' || name === 'Grep') {
    const pattern = toolInput?.pattern as string
    printToolEvent(color, name, pattern)
  } else {
    printToolEvent(color, name, '')
  }

  return {}
}

/** runClaudeCodeAgent executes a Claude Code agent with a prompt. */
export async function runClaudeCodeAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const {
    prompt,
    agent,
    model,
    sessionId,
    timeoutSec = 3600,
    workdir,
    claudeCode,
    signal,
  } = options

  // Check if already aborted
  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  // Claude Code understands simple names: opus, sonnet, haiku
  const modelStr = normalizeModelId(model.modelID)
  const sessionInfo = sessionId ? `[session:${sessionId}]` : '[new session]'
  const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ')

  // Build query options with configurable permission mode (default: acceptEdits)
  const permissionMode = claudeCode?.permissionMode ?? 'acceptEdits'

  // Resolve system prompt: explicit option > agent definition file > none
  const systemPrompt = claudeCode?.systemPrompt ?? loadAgentDefinition(agent, workdir)

  // Bridge external abort signal to an AbortController for the SDK
  const abortController = new AbortController()
  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        console.error(`\n[abort] Aborting Claude Code query...`)
        abortController.abort()
      },
      { once: true },
    )
  }

  // Strip CLAUDECODE env var to allow nested Claude Code sessions.
  // The parent session sets this to block nesting, but SDK-spawned subagents
  // are independent processes that should be allowed to run.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE'),
  )

  const queryOptions: Options = {
    model: modelStr,
    permissionMode,
    abortController,
    env: cleanEnv,
    // v1 persistSession defaults to true, but set explicitly for clarity
    persistSession: true,
    ...(workdir && { cwd: workdir }),
    ...(systemPrompt && { systemPrompt }),
    // Resume from previous session if sessionId provided
    ...(sessionId && { resume: sessionId }),
    hooks: {
      PreToolUse: [{ hooks: [logToolCall] }],
    },
    // Subagent definitions for Task tool dispatch
    ...(claudeCode?.agents && { agents: claudeCode.agents }),
    // Tool allow-list (must include 'Task' for subagent dispatch)
    ...(claudeCode?.allowedTools && { allowedTools: claudeCode.allowedTools }),
    // bypassPermissions requires explicit opt-in
    ...(permissionMode === 'bypassPermissions' &&
      claudeCode?.dangerouslySkipPermissions && {
        allowDangerouslySkipPermissions: true,
      }),
    // Resolve executable path: explicit option > PATH lookup > default locations
    ...(() => {
      const resolved = resolveClaudeCodePath(claudeCode?.pathToClaudeCodeExecutable)
      return resolved ? { pathToClaudeCodeExecutable: resolved } : {}
    })(),
  }

  if (claudeCode?.agents) {
    console.error(`[ocpipe] Subagents defined: ${Object.keys(claudeCode.agents).join(', ')}`)
  }
  if (claudeCode?.allowedTools) {
    console.error(`[ocpipe] Allowed tools: ${claudeCode.allowedTools.join(', ')}`)
  }
  console.error(
    `\n>>> Claude Code [${modelStr}] [${permissionMode}] ${sessionInfo}: ${promptPreview}...`,
  )

  // v1 query() returns an AsyncGenerator — subprocess exits naturally when done,
  // allowing session data to be persisted to disk before the process ends.
  const q = query({ prompt, options: queryOptions })

  let timeoutId: ReturnType<typeof setTimeout> | null = null

  try {
    const textParts: string[] = []
    let newSessionId = sessionId || ''

    // Set up timeout
    const timeoutPromise =
      timeoutSec > 0 ?
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            q.close()
            reject(new Error(`Timeout after ${timeoutSec}s`))
          }, timeoutSec * 1000)
        })
      : null

    // Set up abort promise
    const abortPromise =
      signal ?
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('Request aborted')),
            { once: true },
          )
        })
      : null

    // Stream the response — iterate the AsyncGenerator
    const streamPromise = (async () => {
      for await (const msg of q) {
        if (msg.session_id) {
          newSessionId = msg.session_id
        }

        const text = getAssistantText(msg)
        if (text) {
          textParts.push(text)
          process.stderr.write(text)
          lastOutputEndedWithNewline = text.endsWith('\n')
        }
      }
    })()

    // Race between stream, timeout, and abort
    const promises: Promise<void | never>[] = [streamPromise]
    if (timeoutPromise) promises.push(timeoutPromise)
    if (abortPromise) promises.push(abortPromise)
    await Promise.race(promises)

    if (timeoutId) clearTimeout(timeoutId)

    const response = textParts.join('')
    const sessionStr = newSessionId || 'none'
    console.error(
      `\n<<< Claude Code done (${response.length} chars) [session:${sessionStr}]`,
    )

    // Detect rate limit errors in the response
    if (response.includes("You've hit your limit")) {
      throw new Error('Claude Code rate limit exceeded')
    }

    return {
      text: response,
      sessionId: newSessionId,
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    // v1 subprocess exits naturally when the generator completes — no close() needed.
    // close() is only called on timeout (above) to force-terminate.
  }
}

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdk.query,
}))

import { runClaudeCodeAgent } from './claude-code.js'
import type { RunAgentOptions } from './types.js'

type CapturedQuery = {
  prompt: string
  options: Record<string, unknown>
}

function claudeStream(text = 'Claude response', sessionId = 'claude-session') {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        session_id: sessionId,
        message: { content: [{ type: 'text', text }] },
      }
    },
    close: vi.fn(),
  }
}

describe('runClaudeCodeAgent system prompt resolution', () => {
  let workdirs: string[]

  beforeEach(() => {
    workdirs = []
    sdk.query.mockReset()
    sdk.query.mockReturnValue(claudeStream())
  })

  afterEach(async () => {
    await Promise.all(
      workdirs.map((workdir) => rm(workdir, { recursive: true, force: true })),
    )
  })

  async function createWorkdirWithOpenCodeAgent() {
    const workdir = await mkdtemp(join(tmpdir(), 'ocpipe-claude-code-'))
    workdirs.push(workdir)
    const agentsDir = join(workdir, '.opencode', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'general.md'),
      '---\ndescription: legacy OpenCode agent\n---\nLEGACY OPENCODE SYSTEM PROMPT',
    )
    return workdir
  }

  test('ignores legacy .opencode agent markdown when no explicit system prompt is provided', async () => {
    const workdir = await createWorkdirWithOpenCodeAgent()

    const result = await runClaudeCodeAgent({
      prompt: 'answer plainly',
      model: { backend: 'claude-code', modelID: 'sonnet' },
      workdir,
      timeoutSec: 0,
    } as RunAgentOptions)

    expect(result).toEqual({
      text: 'Claude response',
      sessionId: 'claude-session',
    })
    const captured = sdk.query.mock.calls[0]?.[0] as CapturedQuery
    expect(captured.prompt).toBe('answer plainly')
    expect(captured.options).not.toHaveProperty('systemPrompt')
  })

  test('uses claudeCode.systemPrompt as the only system-prompt source', async () => {
    const workdir = await createWorkdirWithOpenCodeAgent()

    await runClaudeCodeAgent({
      prompt: 'answer plainly',
      model: { backend: 'claude-code', modelID: 'sonnet' },
      workdir,
      timeoutSec: 0,
      claudeCode: { systemPrompt: 'Use the explicit prompt only.' },
    } as RunAgentOptions)

    const captured = sdk.query.mock.calls[0]?.[0] as CapturedQuery
    expect(captured.options.systemPrompt).toBe('Use the explicit prompt only.')
  })
})

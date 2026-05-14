import { beforeEach, describe, expect, test, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  codex: vi.fn(),
  run: vi.fn(),
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}))

vi.mock('@openai/codex-sdk', () => {
  class MockCodex {
    startThread = sdk.startThread
    resumeThread = sdk.resumeThread

    constructor(options: unknown) {
      sdk.codex(options)
    }
  }

  return { Codex: vi.fn(MockCodex) }
})

import { filterCodexLogText, runCodexAgent } from './codex.js'

describe('filterCodexLogText', () => {
  test('suppresses timestamped Codex warning lines', () => {
    const text =
      'before\n' +
      '2026-05-07T22:52:05.951455Z  WARN codex_core::config: ignored key\n' +
      'after\n'

    expect(filterCodexLogText(text)).toBe('before\nafter\n')
  })

  test('preserves unrelated warning output', () => {
    const text = '2026-05-07T22:52:05.951455Z  WARN unrelated warning\n'

    expect(filterCodexLogText(text)).toBe(text)
  })

  test('suppresses Cloudflare HTML challenge blocks from Codex startup', () => {
    const text =
      'before\n' +
      '  <head>\n' +
      '    <meta http-equiv="refresh" content="360">\n' +
      '  </head>\n' +
      '  <body>Enable JavaScript and cookies to continue</body>\n' +
      '</html>\n' +
      'after\n'

    expect(filterCodexLogText(text)).toBe('before\nafter\n')
  })
})

describe('runCodexAgent', () => {
  beforeEach(() => {
    sdk.codex.mockClear()
    sdk.run.mockReset()
    sdk.startThread.mockReset()
    sdk.resumeThread.mockReset()
    sdk.run.mockResolvedValue({
      finalResponse: ' Codex response ',
      items: [],
      usage: null,
    })
    sdk.startThread.mockReturnValue({ id: 'thread-new', run: sdk.run })
    sdk.resumeThread.mockReturnValue({ id: 'thread-existing', run: sdk.run })
  })

  test('starts a Codex SDK thread with mapped options', async () => {
    const result = await runCodexAgent({
      prompt: 'hello',
      agent: 'default',
      model: { backend: 'codex', modelID: 'gpt-5.4' },
      timeoutSec: 10,
      workdir: '/tmp/project',
      codex: {
        pathToCodexExecutable: '/opt/codex',
        baseUrl: 'https://example.test',
        apiKey: 'test-key',
        env: { PATH: '/bin' },
        config: { show_raw_agent_reasoning: true },
        sandbox: 'workspace-write',
        reasoningEffort: 'high',
        addDirs: ['/tmp/extra'],
        approvalPolicy: 'never',
        networkAccessEnabled: true,
        webSearchMode: 'live',
      },
    })

    expect(result).toEqual({
      text: 'Codex response',
      sessionId: 'thread-new',
    })
    expect(sdk.codex).toHaveBeenCalledWith({
      codexPathOverride: '/opt/codex',
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      env: { PATH: '/bin' },
      config: { show_raw_agent_reasoning: true },
    })
    expect(sdk.startThread).toHaveBeenCalledWith({
      model: 'gpt-5.4',
      workingDirectory: '/tmp/project',
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      modelReasoningEffort: 'high',
      additionalDirectories: ['/tmp/extra'],
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      webSearchMode: 'live',
    })
    expect(sdk.run).toHaveBeenCalledWith('hello', {
      signal: expect.any(AbortSignal),
    })
  })

  test('resumes an existing Codex SDK thread', async () => {
    const result = await runCodexAgent({
      prompt: 'continue',
      agent: 'default',
      model: { backend: 'codex', modelID: 'gpt-5.4' },
      sessionId: 'thread-existing',
      workdir: '/tmp/project',
    })

    expect(result.sessionId).toBe('thread-existing')
    expect(sdk.resumeThread).toHaveBeenCalledWith('thread-existing', {
      model: 'gpt-5.4',
      workingDirectory: '/tmp/project',
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
    })
    expect(sdk.startThread).not.toHaveBeenCalled()
  })

  test('ephemeral mode starts a fresh thread and returns no session ID', async () => {
    const result = await runCodexAgent({
      prompt: 'fresh',
      agent: 'default',
      model: { backend: 'codex', modelID: 'gpt-5.4' },
      sessionId: 'thread-existing',
      workdir: '/tmp/project',
      codex: { ephemeral: true },
    })

    expect(result.sessionId).toBe('')
    expect(sdk.startThread).toHaveBeenCalledOnce()
    expect(sdk.resumeThread).not.toHaveBeenCalled()
  })
})

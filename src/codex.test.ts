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

import {
  buildCodexRunSummary,
  filterCodexLogText,
  formatCodexRunSummary,
  runCodexAgent,
} from './codex.js'

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
      runSummary: {
        status: 'completed',
        finalMessage: 'Codex response',
        errorMessage: '',
        commands: [],
        fileChanges: [],
        tokens: null,
      },
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

  test('projects commands, file changes, and tokens into the run summary', async () => {
    sdk.run.mockResolvedValue({
      finalResponse: 'done',
      items: [
        {
          id: 'c1',
          type: 'command_execution',
          command: 'rg foo',
          aggregated_output: '',
          status: 'completed',
          exit_code: 0,
        },
        {
          id: 'c2',
          type: 'command_execution',
          command: 'bun test',
          aggregated_output: '',
          status: 'failed',
          exit_code: 1,
        },
        {
          id: 'f1',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'a.ts', kind: 'update' },
            { path: 'b.ts', kind: 'add' },
          ],
        },
        { id: 'm1', type: 'agent_message', text: 'final answer' },
      ],
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 5,
        reasoning_output_tokens: 3,
      },
    })

    const result = await runCodexAgent({
      prompt: 'go',
      agent: 'default',
      model: { backend: 'codex', modelID: 'gpt-5.4' },
      workdir: '/tmp/project',
    })

    expect(result.runSummary).toEqual({
      status: 'completed',
      finalMessage: 'final answer',
      errorMessage: '',
      commands: [
        { command: 'rg foo', status: 'completed', exitCode: 0 },
        { command: 'bun test', status: 'failed', exitCode: 1 },
      ],
      fileChanges: [
        { path: 'a.ts', kind: 'update', status: 'completed' },
        { path: 'b.ts', kind: 'add', status: 'completed' },
      ],
      tokens: { input: 10, cached: 2, output: 5, reasoning: 3 },
    })
  })
})

describe('buildCodexRunSummary / formatCodexRunSummary', () => {
  test('marks the run failed when an error item is present', () => {
    const summary = buildCodexRunSummary({
      finalResponse: '',
      items: [{ id: 'e1', type: 'error', message: 'patch failed' }],
      usage: null,
    })

    expect(summary.status).toBe('failed')
    expect(summary.errorMessage).toBe('patch failed')
  })

  test('renders a clean text block with counts', () => {
    const text = formatCodexRunSummary({
      status: 'completed',
      finalMessage: 'all good',
      errorMessage: '',
      commands: [
        { command: 'x', status: 'completed', exitCode: 0 },
        { command: 'y', status: 'failed', exitCode: 1 },
      ],
      fileChanges: [
        { path: 'a', kind: 'add', status: 'completed' },
        { path: 'b', kind: 'update', status: 'completed' },
      ],
      tokens: { input: 1, cached: 0, output: 2, reasoning: 3 },
    })

    expect(text).toBe(
      [
        'status: completed',
        'commands: 2 completed, 1 failed',
        'files: add=1 update=1 delete=0',
        'tokens: input=1 cached=0 output=2 reasoning=3',
        'final_message:\nall good',
      ].join('\n'),
    )
  })
})

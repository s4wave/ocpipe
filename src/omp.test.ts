import { describe, expect, test } from 'vitest'
import { runOmpAgent, type OmpProcess } from './omp.js'

describe('runOmpAgent', () => {
  test('maps Oh My Pi JSON output into an agent response', async () => {
    const process = new FakeOmpProcess({
      stdout: [
        JSON.stringify({ type: 'session', id: 'omp-session-1' }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'OMP_PROVE_OK' }],
          },
        }),
      ].join('\n'),
    })

    const result = await runOmpAgent(
      {
        prompt: 'reply with exactly OMP_PROVE_OK',
        agent: 'default',
        model: { backend: 'omp', modelID: 'gpt-5.5' },
        workdir: '/workspace',
        omp: {
          command: 'test-omp',
          processCwd: '/process',
          codexHome: '/codex/home',
          contextStopPercent: 85,
          contextStopTokens: 120000,
          scratchHandoffFile: 'agent/scratch.org',
          env: { OMP_TEST_ENV: '1' },
        },
      },
      process,
    )

    expect(process.request).toMatchObject({
      command: 'test-omp',
      cwd: '/process',
      args: [
        '--print',
        '--mode',
        'json',
        '--cwd',
        '/workspace',
        '--model',
        'gpt-5.5',
        '--codex-home',
        '/codex/home',
        '--context-stop-percent',
        '85',
        '--context-stop-tokens',
        '120000',
        '--scratch-handoff-file',
        '/workspace/agent/scratch.org',
        '--auto-approve',
        '--approval-mode',
        'yolo',
        '--thinking',
        'high',
        '--',
        'reply with exactly OMP_PROVE_OK',
      ],
    })
    expect(process.request?.env.OMP_TEST_ENV).toBe('1')
    expect(process.request?.env.CODEX_HOME).toBeUndefined()
    expect(result).toEqual({
      text: 'OMP_PROVE_OK',
      sessionId: 'omp-session-1',
    })
  })

  test('resumes with an existing session ID', async () => {
    const process = new FakeOmpProcess({
      stdout: JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    })

    await runOmpAgent(
      {
        prompt: 'continue',
        agent: 'default',
        model: { backend: 'omp', modelID: 'gpt-5.5' },
        sessionId: 'omp-session-1',
      },
      process,
    )

    expect(process.request?.args).toContain('--resume')
    expect(process.request?.args).toContain('omp-session-1')
  })

  test('reports process failures without leaking raw JSON as the main result', async () => {
    const process = new FakeOmpProcess({
      stdout: JSON.stringify({ type: 'session', id: 'omp-session-1' }),
      stderr: 'boom',
      exitCode: 1,
    })

    await expect(
      runOmpAgent(
        {
          prompt: 'hello',
          agent: 'default',
          model: { backend: 'omp', modelID: 'gpt-5.5' },
        },
        process,
      ),
    ).rejects.toThrow('boom')
  })

  test('accepts plain text output for non-json compatible commands', async () => {
    const process = new FakeOmpProcess({ stdout: 'plain reply' })

    const result = await runOmpAgent(
      {
        prompt: 'hello',
        agent: 'default',
        model: { backend: 'omp', modelID: 'gpt-5.5' },
      },
      process,
    )

    expect(result).toEqual({ text: 'plain reply', sessionId: '' })
  })
})

class FakeOmpProcess implements OmpProcess {
  request:
    | {
        command: string
        args: string[]
        cwd: string
        env: NodeJS.ProcessEnv
      }
    | undefined

  constructor(
    private readonly result: {
      stdout: string
      stderr?: string
      exitCode?: number | null
      signal?: NodeJS.Signals | null
    },
  ) {}

  run(req: {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
  }) {
    this.request = req
    return Promise.resolve({
      stdout: this.result.stdout,
      stderr: this.result.stderr ?? '',
      exitCode: this.result.exitCode ?? 0,
      signal: this.result.signal ?? null,
    })
  }
}

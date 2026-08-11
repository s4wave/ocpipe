import { describe, expect, test } from 'vitest'
import { runPrimeAgent, type PrimeProcess } from './prime.js'

function processResult(stdout: string): PrimeProcess {
  return {
    async run() {
      return { stdout, stderr: '', exitCode: 0, signal: null }
    },
  }
}

describe('runPrimeAgent', () => {
  test('runs Prime Agent in the target working directory and reads its final response', async () => {
    let request:
      | { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
      | undefined
    const process: PrimeProcess = {
      async run(req) {
        request = req
        return {
          stdout: [
            JSON.stringify({ type: 'session', id: 'prime-session-1' }),
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Prime response' }],
              },
            }),
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          signal: null,
        }
      },
    }

    await expect(
      runPrimeAgent(
        {
          prompt: 'hello',
          model: { backend: 'prime', modelID: 'openai/gpt-5' },
          workdir: '/tmp/project',
          prime: {
            command: '/opt/prime-agent/prime-agent.sh',
            thinking: 'high',
          },
        },
        process,
      ),
    ).resolves.toEqual({
      text: 'Prime response',
      sessionId: 'prime-session-1',
    })
    expect(request).toMatchObject({
      command: '/opt/prime-agent/prime-agent.sh',
      cwd: '/tmp/project',
    })
    expect(request?.args).toEqual([
      '--print',
      '--mode',
      'json',
      '--cwd',
      '/tmp/project',
      '--model',
      'openai/gpt-5',
      '--thinking',
      'high',
      '--',
      'hello',
    ])
  })

  test('resumes the prior Prime Agent session', async () => {
    let args: string[] = []
    const process: PrimeProcess = {
      async run(req) {
        args = req.args
        return {
          stdout: [
            JSON.stringify({ type: 'session', id: 'prime-session-1' }),
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'continued' }],
              },
            }),
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          signal: null,
        }
      },
    }

    await runPrimeAgent(
      {
        prompt: 'continue',
        model: { backend: 'prime', modelID: '' },
        sessionId: 'prime-session-1',
      },
      process,
    )

    expect(args).toContain('--resume')
    expect(args).toContain('prime-session-1')
    expect(args).not.toContain('--model')
  })

  test('rejects an empty JSON response', async () => {
    await expect(
      runPrimeAgent(
        { prompt: 'hello', model: { backend: 'prime', modelID: '' } },
        processResult(JSON.stringify({ type: 'agent_end', messages: [] })),
      ),
    ).rejects.toThrow('Prime Agent returned an empty final message')
  })
})

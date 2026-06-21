import { describe, expect, test } from 'vitest'
import { runPiAgent, type PiConnection, type PiProcess } from './pi.js'

describe('runPiAgent', () => {
  test('maps Pi RPC result into an agent response', async () => {
    const conn = new FakePiConnection(
      piResponse('get_state', {
        sessionId: 'pi-session-1',
        model: { provider: 'llama-cpp', id: 'gemma' },
      }),
      piResponse('prompt', { command: 'prompt' }),
      { type: 'agent_end' },
      piResponse('get_last_assistant_text', { text: 'LOCAL_PROVE_OK' }),
      piResponse('get_state', {
        sessionId: 'pi-session-1',
        model: { provider: 'llama-cpp', id: 'gemma' },
      }),
    )
    const process = new FakePiProcess(conn)

    const result = await runPiAgent(
      {
        prompt: 'reply with exactly LOCAL_PROVE_OK',
        agent: 'default',
        model: { backend: 'pi', modelID: 'gemma' },
        workdir: '/workspace',
        pi: {
          command: 'test-pi',
          providerHome: '/pi/home',
          baseUrl: 'http://127.0.0.1:4269/v1',
        },
      },
      process,
    )

    expect(process.request).toMatchObject({
      command: 'test-pi',
      args: [
        '--mode',
        'rpc',
        '--approve',
        '--session-dir',
        '/pi/home/sessions',
        '--model',
        'gemma',
      ],
      cwd: '/workspace',
    })
    expect(process.request?.env.PI_CODING_AGENT_DIR).toBe('/pi/home')
    expect(process.request?.env.PI_CODING_AGENT_SESSION_DIR).toBe(
      '/pi/home/sessions',
    )
    expect(process.request?.env.LLAMA_BASE_URL).toBe('http://127.0.0.1:4269/v1')
    expect(conn.sent).toContainEqual(
      expect.stringContaining('"message":"reply with exactly LOCAL_PROVE_OK"'),
    )
    expect(result).toEqual({
      text: 'LOCAL_PROVE_OK',
      sessionId: 'pi-session-1',
    })
  })

  test('resumes with an existing session ID', async () => {
    const conn = new FakePiConnection(
      piResponse('get_state', { sessionId: 'pi-session-1' }),
      piResponse('prompt', { command: 'prompt' }),
      { type: 'agent_end' },
      piResponse('get_last_assistant_text', { text: 'done' }),
      piResponse('get_state', { sessionId: 'pi-session-1' }),
    )
    const process = new FakePiProcess(conn)

    await runPiAgent(
      {
        prompt: 'continue',
        agent: 'default',
        model: { backend: 'pi', modelID: 'gemma' },
        sessionId: 'pi-session-1',
      },
      process,
    )

    expect(process.request?.args).toContain('--session-id')
    expect(process.request?.args).toContain('pi-session-1')
  })

  test('reports RPC failures', async () => {
    const conn = new FakePiConnection({
      type: 'response',
      success: false,
      error: 'model offline',
    })

    await expect(
      runPiAgent(
        {
          prompt: 'hello',
          agent: 'default',
          model: { backend: 'pi', modelID: 'gemma' },
        },
        new FakePiProcess(conn),
      ),
    ).rejects.toThrow('model offline')
  })

  test('requires a final session ID and message', async () => {
    const conn = new FakePiConnection(
      piResponse('get_state', {}),
      piResponse('prompt', { command: 'prompt' }),
      { type: 'agent_end' },
      piResponse('get_last_assistant_text', { text: 'done' }),
      piResponse('get_state', {}),
    )

    await expect(
      runPiAgent(
        {
          prompt: 'hello',
          agent: 'default',
          model: { backend: 'pi', modelID: 'gemma' },
        },
        new FakePiProcess(conn),
      ),
    ).rejects.toThrow('provider session ID')
  })
})

function piResponse(command: string, data: Record<string, unknown>) {
  return {
    type: 'response',
    command,
    success: true,
    data,
  }
}

class FakePiProcess implements PiProcess {
  request:
    | {
        command: string
        args: string[]
        cwd: string
        env: NodeJS.ProcessEnv
      }
    | undefined

  constructor(private readonly conn: FakePiConnection) {}

  start(req: {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
  }): PiConnection {
    this.request = req
    return this.conn
  }
}

class FakePiConnection implements PiConnection {
  readonly sent: string[] = []
  private cursor = 0
  private lastID = ''

  constructor(...scripted: Array<Record<string, unknown>>) {
    this.scripted = scripted
  }

  private readonly scripted: Array<Record<string, unknown>>

  send(line: string): void {
    this.sent.push(line)
    const value = JSON.parse(line) as { id?: string }
    this.lastID = value.id ?? ''
  }

  async recv(): Promise<string> {
    const value = this.scripted[this.cursor]
    this.cursor++
    if (!value) {
      throw new Error('no more scripted Pi lines')
    }
    if (value.type !== 'response' || !this.lastID) {
      return JSON.stringify(value)
    }
    return JSON.stringify({ ...value, id: this.lastID })
  }

  close(): void {}
}

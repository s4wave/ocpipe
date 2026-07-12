import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { RunAgentResult } from './types.js'
import { TMP_DIR } from './paths.js'

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

const ompBackend = vi.hoisted(() => ({
  runOmpAgent: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: childProcess.spawn,
}))

vi.mock('./omp.js', () => ({
  runOmpAgent: ompBackend.runOmpAgent,
}))

import { runAgent } from './agent.js'

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: Mock
}

function successfulOpenCodeProcess() {
  const proc = new EventEmitter() as FakeProcess
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from('OpenCode response'))
    proc.emit('close', 0)
  })
  return proc
}
class FakeReadable extends EventEmitter {
  private paused = false

  isPaused(): boolean {
    return this.paused
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    if (this.paused) {
      this.paused = false
      this.emit('resume')
    }
    return this
  }
}

function floodingOpenCodeProcess() {
  const proc = new EventEmitter() as FakeProcess & { killed?: boolean }
  const stdout = new FakeReadable()
  const stderr = new FakeReadable()
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = vi.fn(() => {
    proc.killed = true
  })
  const chunk = Buffer.alloc(64 * 1024, 'x')
  const chunkCount = 512
  let emitted = 0

  queueMicrotask(() => {
    stderr.emit('data', Buffer.from('[session:flood-session]\n'))
    const emitNext = () => {
      if (stdout.isPaused()) {
        stdout.once('resume', emitNext)
        return
      }
      if (emitted === chunkCount) {
        proc.emit('close', 0)
        return
      }
      emitted++
      stdout.emit('data', chunk)
      queueMicrotask(emitNext)
    }
    emitNext()
  })
  return proc
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('runAgent backend selection', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset()
    childProcess.spawn.mockImplementation(successfulOpenCodeProcess)
    ompBackend.runOmpAgent.mockReset()
    ompBackend.runOmpAgent.mockResolvedValue({
      text: 'OMP response',
      sessionId: 'omp-session',
    })
  })

  test('omitting model.backend routes to OMP without creating .opencode prompts', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'ocpipe-run-agent-default-'))
    try {
      let result: RunAgentResult | undefined
      let thrown: unknown

      try {
        result = await runAgent({
          prompt: 'route through the default backend',
          model: { providerID: 'legacy-provider', modelID: 'legacy-model' },
          workdir,
          timeoutSec: 0,
        })
      } catch (error) {
        thrown = error
      }

      expect(ompBackend.runOmpAgent).toHaveBeenCalledOnce()
      expect(childProcess.spawn).not.toHaveBeenCalled()
      expect(await pathExists(join(workdir, '.opencode', 'prompts'))).toBe(
        false,
      )
      if (!thrown) {
        expect(result).toEqual({
          text: 'OMP response',
          sessionId: 'omp-session',
        })
      }
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  test('OpenCode backend does not require or pass named agents', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'ocpipe-run-agent-opencode-'))
    try {
      const result = await runAgent({
        prompt: 'send prompt directly without a named agent',
        model: {
          backend: 'opencode',
          providerID: 'legacy-provider',
          modelID: 'legacy-model',
        },
        workdir,
        timeoutSec: 0,
      })

      expect(result).toEqual({ text: 'OpenCode response', sessionId: '' })
      expect(childProcess.spawn).toHaveBeenCalledOnce()
      const spawnArgs = childProcess.spawn.mock.calls[0]?.[1] as string[]
      expect(spawnArgs).not.toContain('--agent')
      const promptFileFlag = spawnArgs.indexOf('--prompt-file')
      expect(promptFileFlag).toBeGreaterThanOrEqual(0)
      const promptFile = spawnArgs[promptFileFlag + 1]
      expect(promptFile).toBeTruthy()
      expect(promptFile).not.toContain(`${sep}.opencode${sep}`)
      expect(promptFile?.startsWith(join(workdir, '.opencode'))).toBe(false)
      expect(await pathExists(join(workdir, '.opencode'))).toBe(false)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
  test('streams large child output through disk without an in-memory chunk accumulator', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'ocpipe-run-agent-stream-'))
    const filesBefore = new Set(
      (await readdir(TMP_DIR)).filter((name) =>
        name.startsWith('ocpipe_output_'),
      ),
    )
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)
    childProcess.spawn.mockImplementation(floodingOpenCodeProcess)
    try {
      const result = await runAgent({
        prompt: 'stream a large response',
        model: {
          backend: 'opencode',
          providerID: 'legacy-provider',
          modelID: 'legacy-model',
        },
        workdir,
        timeoutSec: 0,
      })

      expect(result.sessionId).toBe('flood-session')
      expect(result.text).toHaveLength(32 * 1024 * 1024)
      const filesAfter = new Set(
        (await readdir(TMP_DIR)).filter((name) =>
          name.startsWith('ocpipe_output_'),
        ),
      )
      expect([...filesAfter].filter((name) => !filesBefore.has(name))).toEqual(
        [],
      )
    } finally {
      stderrWrite.mockRestore()
      await rm(workdir, { recursive: true, force: true })
    }
  })
})

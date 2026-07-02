import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { RunAgentResult } from './types.js'

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
})

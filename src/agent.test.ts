import { beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RunAgentOptions, RunAgentResult } from './types.js'

const ompBackend = vi.hoisted(() => ({
  runOmpAgent: vi.fn(),
}))

vi.mock('./omp.js', () => ({
  runOmpAgent: ompBackend.runOmpAgent,
}))

import { runAgent } from './agent.js'

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
        } as RunAgentOptions)
      } catch (error) {
        thrown = error
      }

      expect(ompBackend.runOmpAgent).toHaveBeenCalledOnce()
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

  test('OpenCode is no longer a supported backend', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'ocpipe-run-agent-opencode-'))
    try {
      await expect(
        runAgent({
          prompt: 'do not spawn OpenCode',
          model: {
            backend: 'opencode',
            providerID: 'legacy-provider',
            modelID: 'legacy-model',
          },
          workdir,
          timeoutSec: 0,
        } as unknown as RunAgentOptions),
      ).rejects.toThrow('Unsupported backend: opencode')
      expect(ompBackend.runOmpAgent).not.toHaveBeenCalled()
      expect(await pathExists(join(workdir, '.opencode'))).toBe(false)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
})

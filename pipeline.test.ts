import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Pipeline } from './pipeline.js'
import { Module } from './module.js'
import { Predict } from './predict.js'
import { signature, field } from './signature.js'
import { createBaseState } from './state.js'
import { MockAgentBackend, createMockContext } from './testing.js'
import type { ExecutionContext, BaseState } from './types.js'
import * as agentModule from './agent.js'
import * as fs from 'fs/promises'

// Mock the agent module
vi.mock('./agent.js', async (importOriginal) => {
  const original = await importOriginal<typeof agentModule>()
  return {
    ...original,
    runAgent: vi.fn(),
  }
})

const mockRunAgent = vi.mocked(agentModule.runAgent)

// Test fixtures
const TestSig = signature({
  doc: 'Test signature',
  inputs: { input: field.string() },
  outputs: { output: field.string() },
})

class TestModule extends Module<{ input: string }, { output: string }> {
  private pred = this.predict(TestSig)

  async forward(input: { input: string }, ctx: ExecutionContext) {
    const result = await this.pred.execute(input, ctx)
    return { output: result.data.output }
  }
}

class SimpleModule extends Module<{ value: string }, { result: string }> {
  async forward(input: { value: string }, _ctx: ExecutionContext) {
    return { result: input.value.toUpperCase() }
  }
}

interface TestState extends BaseState {
  customField: string
}

describe('Module', () => {
  let mockBackend: MockAgentBackend

  beforeEach(() => {
    mockBackend = new MockAgentBackend()
    mockRunAgent.mockImplementation(mockBackend.createRunner())
  })

  it('registers predictors via this.predict()', () => {
    const module = new TestModule()
    const predictors = module.getPredictors()
    expect(predictors).toHaveLength(1)
    expect(predictors[0]).toBeInstanceOf(Predict)
  })

  it('executes forward method with context', async () => {
    mockBackend.addJsonResponse({ output: 'hello world' })

    const module = new TestModule()
    const ctx = createMockContext()

    const result = await module.forward({ input: 'test' }, ctx)
    expect(result).toEqual({ output: 'hello world' })
  })

  it('can work without predictions (pure logic)', async () => {
    const module = new SimpleModule()
    const ctx = createMockContext()

    const result = await module.forward({ value: 'hello' }, ctx)
    expect(result).toEqual({ result: 'HELLO' })
  })
})

describe('Pipeline', () => {
  let mockBackend: MockAgentBackend
  const testCheckpointDir = '/tmp/dsts-test-checkpoints'

  beforeEach(async () => {
    mockBackend = new MockAgentBackend()
    mockRunAgent.mockImplementation(mockBackend.createRunner())

    // Create test checkpoint directory
    await fs.mkdir(testCheckpointDir, { recursive: true })
  })

  afterEach(async () => {
    // Clean up test checkpoints
    try {
      const files = await fs.readdir(testCheckpointDir)
      for (const file of files) {
        await fs.unlink(`${testCheckpointDir}/${file}`)
      }
    } catch {
      // Ignore errors
    }
  })

  const defaultConfig = {
    name: 'test-pipeline',
    defaultModel: { providerID: 'test', modelID: 'test-model' },
    defaultAgent: 'general',
    checkpointDir: testCheckpointDir,
    logDir: '/tmp',
  }

  it('creates pipeline with initial state', () => {
    const pipeline = new Pipeline<TestState>(defaultConfig, () => ({
      ...createBaseState(),
      customField: 'test',
    }))

    expect(pipeline.state.sessionId).toBeDefined()
    expect(pipeline.state.phase).toBe('init')
    expect(pipeline.state.customField).toBe('test')
    expect(pipeline.state.steps).toEqual([])
  })

  it('runs a module and records step', async () => {
    mockBackend.addJsonResponse({ output: 'result' })

    const pipeline = new Pipeline(defaultConfig, createBaseState)
    const module = new TestModule()

    const result = await pipeline.run(module, { input: 'test' })

    expect(result.data).toEqual({ output: 'result' })
    expect(result.stepName).toBe('TestModule')
    expect(result.attempt).toBe(1)
    expect(pipeline.state.steps).toHaveLength(1)
    expect(pipeline.state.steps[0]?.stepName).toBe('TestModule')
  })

  it('uses custom step name', async () => {
    mockBackend.addJsonResponse({ output: 'result' })

    const pipeline = new Pipeline(defaultConfig, createBaseState)
    const module = new TestModule()

    await pipeline.run(module, { input: 'test' }, { name: 'custom-step' })

    expect(pipeline.state.steps[0]?.stepName).toBe('custom-step')
  })

  it('maintains session continuity', async () => {
    mockBackend
      .addJsonResponse({ output: 'first' }, { sessionId: 'session-1' })
      .addJsonResponse({ output: 'second' }, { sessionId: 'session-1' })

    const pipeline = new Pipeline(defaultConfig, createBaseState)
    const module = new TestModule()

    await pipeline.run(module, { input: 'first' })
    await pipeline.run(module, { input: 'second' })

    // Second call should use session from first call
    const calls = mockBackend.getCalls()
    expect(calls[1]?.sessionId).toBe('session-1')
  })

  it('starts new session when requested', async () => {
    mockBackend
      .addJsonResponse({ output: 'first' }, { sessionId: 'session-1' })
      .addJsonResponse({ output: 'second' }, { sessionId: 'session-2' })

    const pipeline = new Pipeline(defaultConfig, createBaseState)
    const module = new TestModule()

    await pipeline.run(module, { input: 'first' })
    await pipeline.run(module, { input: 'second' }, { newSession: true })

    const calls = mockBackend.getCalls()
    expect(calls[1]?.sessionId).toBeUndefined()
  })

  it('retries on failure', async () => {
    // First call fails, second succeeds
    mockBackend
      .addResponse({ error: new Error('Transient error') })
      .addJsonResponse({ output: 'success' })

    const pipeline = new Pipeline(
      { ...defaultConfig, retry: { maxAttempts: 2, onParseError: true } },
      createBaseState,
    )
    const module = new TestModule()

    const result = await pipeline.run(module, { input: 'test' })

    expect(result.data).toEqual({ output: 'success' })
    expect(result.attempt).toBe(2)
    expect(mockBackend.getCallCount()).toBe(2)
  })

  it('throws after max retries exceeded', async () => {
    mockBackend
      .addResponse({ error: new Error('Error 1') })
      .addResponse({ error: new Error('Error 2') })

    const pipeline = new Pipeline(
      { ...defaultConfig, retry: { maxAttempts: 2 } },
      createBaseState,
    )
    const module = new TestModule()

    await expect(pipeline.run(module, { input: 'test' })).rejects.toThrow()
  })

  it('saves checkpoint after each step', async () => {
    mockBackend.addJsonResponse({ output: 'result' })

    const pipeline = new Pipeline(defaultConfig, createBaseState)
    const module = new TestModule()

    await pipeline.run(module, { input: 'test' })

    // Check checkpoint file exists
    const checkpointPath = `${testCheckpointDir}/${defaultConfig.name}_${pipeline.state.sessionId}.json`
    const stat = await fs.stat(checkpointPath)
    expect(stat.isFile()).toBe(true)
  })

  it('tracks phase changes', async () => {
    const pipeline = new Pipeline(defaultConfig, createBaseState)

    expect(pipeline.state.phase).toBe('init')

    pipeline.setPhase('processing')
    expect(pipeline.state.phase).toBe('processing')

    pipeline.setPhase('complete')
    expect(pipeline.state.phase).toBe('complete')
  })

  it('runs sub-pipeline with isolated session', async () => {
    mockBackend
      .addJsonResponse({ output: 'main' }, { sessionId: 'main-session' })
      .addJsonResponse({ output: 'sub' }, { sessionId: 'sub-session' })

    const mainPipeline = new Pipeline(defaultConfig, createBaseState)
    const module = new TestModule()

    // Run in main pipeline
    await mainPipeline.run(module, { input: 'main' })

    // Run sub-pipeline
    const subResult = await mainPipeline.runSub(
      { ...defaultConfig, name: 'sub-pipeline' },
      createBaseState,
      async (sub) => {
        const r = await sub.run(module, { input: 'sub' })
        return r.data
      },
    )

    expect(subResult.data).toEqual({ output: 'sub' })
    expect(mainPipeline.state.subPipelines).toHaveLength(1)
    expect(mainPipeline.state.subPipelines[0]?.name).toBe('sub-pipeline')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Predict } from './predict.js'
import { signature, field } from './signature.js'
import { MockAgentBackend, createMockContext } from './testing.js'
import * as agentModule from './agent.js'

// Mock the agent module
vi.mock('./agent.js', async (importOriginal) => {
  const original = await importOriginal<typeof agentModule>()
  return {
    ...original,
    runAgent: vi.fn(),
  }
})

const mockRunAgent = vi.mocked(agentModule.runAgent)

describe('Predict', () => {
  let mockBackend: MockAgentBackend

  beforeEach(() => {
    mockBackend = new MockAgentBackend()
    mockRunAgent.mockImplementation(mockBackend.createRunner())
  })

  const TestSig = signature({
    doc: 'Extract name and age from text',
    inputs: {
      text: field.string('Input text'),
    },
    outputs: {
      name: field.string('Extracted name'),
      age: field.number('Extracted age'),
    },
  })

  it('executes a signature and parses JSON response', async () => {
    mockBackend.addJsonResponse({ name: 'John', age: 30 })

    const predict = new Predict(TestSig)
    const ctx = createMockContext()

    const result = await predict.execute({ text: 'John is 30 years old' }, ctx)

    expect(result.data).toEqual({ name: 'John', age: 30 })
    expect(result.sessionId).toBe('mock-session-001')
    expect(result.duration).toBeGreaterThan(0)
  })

  it('updates context with session ID', async () => {
    mockBackend.addJsonResponse(
      { name: 'Jane', age: 25 },
      { sessionId: 'new-session-123' },
    )

    const predict = new Predict(TestSig)
    const ctx = createMockContext()

    await predict.execute({ text: 'Jane is 25' }, ctx)

    expect(ctx.sessionId).toBe('new-session-123')
  })

  it('reuses existing session ID from context', async () => {
    mockBackend.addJsonResponse({ name: 'Bob', age: 40 })

    const predict = new Predict(TestSig)
    const ctx = createMockContext({ sessionId: 'existing-session' })

    await predict.execute({ text: 'Bob is 40' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.sessionId).toBe('existing-session')
  })

  it('starts new session when config.newSession is true', async () => {
    mockBackend.addJsonResponse({ name: 'Alice', age: 35 })

    const predict = new Predict(TestSig, { newSession: true })
    const ctx = createMockContext({ sessionId: 'existing-session' })

    await predict.execute({ text: 'Alice is 35' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.sessionId).toBeUndefined()
  })

  it('uses custom agent from config', async () => {
    mockBackend.addJsonResponse({ name: 'Test', age: 1 })

    const predict = new Predict(TestSig, { agent: 'custom-agent' })
    const ctx = createMockContext()

    await predict.execute({ text: 'Test' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.agent).toBe('custom-agent')
  })

  it('uses custom model from config', async () => {
    mockBackend.addJsonResponse({ name: 'Test', age: 1 })

    const customModel = { providerID: 'custom', modelID: 'custom-model' }
    const predict = new Predict(TestSig, { model: customModel })
    const ctx = createMockContext()

    await predict.execute({ text: 'Test' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.model).toEqual(customModel)
  })

  it('parses marker format response', async () => {
    mockBackend.addMarkerResponse({ name: 'Marker Test', age: 99 })

    const predict = new Predict(TestSig, { format: 'markers' })
    const ctx = createMockContext()

    const result = await predict.execute({ text: 'Test' }, ctx)

    expect(result.data.name).toBe('Marker Test')
    expect(result.data.age).toBe(99)
  })

  it('uses custom template when provided', async () => {
    mockBackend.addJsonResponse({ name: 'Custom', age: 42 })

    const customTemplate = (inputs: Record<string, unknown>) =>
      `CUSTOM: ${inputs.text}`

    const predict = new Predict(TestSig, { template: customTemplate })
    const ctx = createMockContext()

    await predict.execute({ text: 'Hello' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.prompt).toBe('CUSTOM: Hello')
  })

  it('generates structured prompt from signature', async () => {
    mockBackend.addJsonResponse({ name: 'Test', age: 1 })

    const predict = new Predict(TestSig)
    const ctx = createMockContext()

    await predict.execute({ text: 'Input value' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.prompt).toContain('Extract name and age from text')
    expect(call?.prompt).toContain('INPUTS:')
    expect(call?.prompt).toContain('text')
    expect(call?.prompt).toContain('Input value')
    expect(call?.prompt).toContain('OUTPUT FORMAT (JSON):')
    expect(call?.prompt).toContain('"name"')
    expect(call?.prompt).toContain('"age"')
  })

  it('generates marker format prompt', async () => {
    mockBackend.addMarkerResponse({ name: 'Test', age: 1 })

    const predict = new Predict(TestSig, { format: 'markers' })
    const ctx = createMockContext()

    await predict.execute({ text: 'Test' }, ctx)

    const call = mockBackend.getLastCall()
    expect(call?.prompt).toContain('[[ ## name ## ]]')
    expect(call?.prompt).toContain('[[ ## age ## ]]')
    expect(call?.prompt).toContain('[[ ## completed ## ]]')
  })

  it('preserves raw response in result', async () => {
    const rawJson = '{"name": "Raw", "age": 123}'
    mockBackend.addResponse({ response: rawJson })

    const predict = new Predict(TestSig)
    const ctx = createMockContext()

    const result = await predict.execute({ text: 'Test' }, ctx)

    expect(result.raw).toBe(rawJson)
  })

  it('throws on invalid response', async () => {
    mockBackend.addResponse({ response: 'not json' })

    const predict = new Predict(TestSig)
    const ctx = createMockContext()

    await expect(predict.execute({ text: 'Test' }, ctx)).rejects.toThrow()
  })
})

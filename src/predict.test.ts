import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Predict } from './predict.js'
import { signature, field } from './signature.js'
import { MockAgentBackend, createMockContext } from './testing.js'
import * as agentModule from './agent.js'

// Mock the agent module - Bun-compatible approach using spyOn
const mockRunAgent = vi.spyOn(agentModule, 'runAgent')

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
    expect(result.duration).toBeGreaterThanOrEqual(0)
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
    expect(call?.prompt).toContain('OUTPUT FORMAT:')
    expect(call?.prompt).toContain('"name"')
    expect(call?.prompt).toContain('"age"')
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

  it('corrects JSON responses with json-patch', async () => {
    // First response: missing required 'age' field
    mockBackend.addJsonResponse({ name: 'John Doe' })

    // Correction response: valid JSON Patch to add missing field
    mockBackend.addResponse({
      response: '```json\n[{"op": "add", "path": "/age", "value": 30}]\n```',
    })

    const predict = new Predict(TestSig)
    const ctx = createMockContext()

    const result = await predict.execute({ text: 'Test' }, ctx)

    // After correction, should have both fields
    expect(result.data.name).toBe('John Doe')
    expect(result.data.age).toBe(30)

    // Verify correction was attempted (2 calls total)
    expect(mockBackend.getCallCount()).toBe(2)
  })
})

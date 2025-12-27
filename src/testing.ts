/**
 * ocpipe testing utilities.
 *
 * Provides mock backends and test helpers for unit testing ocpipe components.
 */

import type { RunAgentOptions, RunAgentResult, FieldConfig } from './types.js'

/** MockResponse defines a mock LLM response for testing. */
export interface MockResponse {
  /** Pattern to match against prompts (string or regex). */
  match?: string | RegExp
  /** The mock response text to return (required unless error is set). */
  response?: string
  /** Optional session ID to return. */
  sessionId?: string
  /** Optional delay in ms to simulate network latency. */
  delay?: number
  /** Optional error to throw instead of returning response. */
  error?: Error
}

/** MockAgentBackend provides a mock implementation of runAgent for testing. */
export class MockAgentBackend {
  private responses: MockResponse[] = []
  private calls: RunAgentOptions[] = []
  private defaultSessionId = 'mock-session-001'
  private callCount = 0

  /** addResponse adds a mock response to the queue. */
  addResponse(response: MockResponse): this {
    this.responses.push(response)
    return this
  }

  /** addJsonResponse adds a mock JSON response. */
  addJsonResponse(
    data: Record<string, unknown>,
    options?: Partial<MockResponse>,
  ): this {
    return this.addResponse({
      response: JSON.stringify(data, null, 2),
      ...options,
    })
  }

  /** getCalls returns all recorded calls. */
  getCalls(): RunAgentOptions[] {
    return this.calls
  }

  /** getLastCall returns the most recent call. */
  getLastCall(): RunAgentOptions | undefined {
    return this.calls[this.calls.length - 1]
  }

  /** getCallCount returns the number of calls made. */
  getCallCount(): number {
    return this.callCount
  }

  /** reset clears all responses and calls. */
  reset(): this {
    this.responses = []
    this.calls = []
    this.callCount = 0
    return this
  }

  /** runAgent is the mock implementation. */
  async runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
    this.calls.push(options)
    this.callCount++

    // Find matching response and consume it
    let responseIndex = -1
    let response: MockResponse | undefined

    for (let i = 0; i < this.responses.length; i++) {
      const r = this.responses[i]
      if (!r) continue

      if (!r.match) {
        response = r
        responseIndex = i
        break
      }
      if (typeof r.match === 'string' && options.prompt.includes(r.match)) {
        response = r
        responseIndex = i
        break
      }
      if (r.match instanceof RegExp && r.match.test(options.prompt)) {
        response = r
        responseIndex = i
        break
      }
    }

    // Consume the response (remove from queue)
    if (responseIndex >= 0) {
      this.responses.splice(responseIndex, 1)
    }

    if (!response) {
      // Return default empty JSON response
      response = { response: '{}' }
    }

    // Simulate delay
    if (response.delay) {
      await new Promise((resolve) => setTimeout(resolve, response.delay))
    }

    // Throw error if specified
    if (response.error) {
      throw response.error
    }

    return {
      text: response.response ?? '',
      sessionId:
        response.sessionId ?? options.sessionId ?? this.defaultSessionId,
    }
  }

  /** createRunner returns a bound runAgent function for use with vi.mock. */
  createRunner(): (options: RunAgentOptions) => Promise<RunAgentResult> {
    return this.runAgent.bind(this)
  }
}

/** createMockContext creates a test execution context. */
export function createMockContext(
  overrides?: Partial<{
    sessionId: string
    defaultModel: { providerID: string; modelID: string }
    defaultAgent: string
    timeoutSec: number
  }>,
) {
  return {
    sessionId: overrides?.sessionId,
    defaultModel: overrides?.defaultModel ?? {
      providerID: 'github-copilot',
      modelID: 'grok-code-fast-1',
    },
    defaultAgent: overrides?.defaultAgent ?? 'general',
    timeoutSec: overrides?.timeoutSec ?? 60,
  }
}

/** generateMockOutputs creates mock output data based on a schema. */
export function generateMockOutputs(
  schema: Record<string, FieldConfig>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, config] of Object.entries(schema)) {
    // Use constructor name for type detection (works across zod versions)
    const typeName = config.type.constructor.name

    switch (typeName) {
      case 'ZodString':
        result[name] = `mock_${name}`
        break
      case 'ZodNumber':
        result[name] = 42
        break
      case 'ZodBoolean':
        result[name] = true
        break
      case 'ZodArray':
        result[name] = []
        break
      case 'ZodObject':
        result[name] = {}
        break
      case 'ZodEnum':
        // Get first enum value via options property
        const enumType = config.type as { options?: readonly string[] }
        result[name] = enumType.options?.[0] ?? 'unknown'
        break
      default:
        result[name] = null
    }
  }
  return result
}

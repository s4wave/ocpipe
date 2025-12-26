/**
 * DSTS SDK response parsing.
 *
 * Extracts and validates LLM responses using JSON or field marker formats.
 */

import { z } from 'zod'
import type { FieldConfig, OutputFormat } from './types.js'

/** JsonParseError is thrown when JSON parsing fails. */
export class JsonParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message)
    this.name = 'JsonParseError'
  }
}

/** MarkerParseError is thrown when field marker parsing fails. */
export class MarkerParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message)
    this.name = 'MarkerParseError'
  }
}

/** ValidationError is thrown when Zod validation fails. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly zodError: z.ZodError,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** parseResponse parses and validates an LLM response based on format. */
export function parseResponse<T>(
  response: string,
  outputSchema: Record<string, FieldConfig>,
  format: OutputFormat,
): T {
  if (format === 'markers') {
    return parseMarkers(response, outputSchema)
  }
  return parseJson(response, outputSchema)
}

/** parseJson extracts and validates JSON from an LLM response. */
export function parseJson<T>(
  response: string,
  schema: Record<string, FieldConfig>,
): T {
  // Try to find JSON in code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?)```/)
  let jsonStr = codeBlockMatch?.[1]?.trim()

  if (!jsonStr) {
    // Try to find raw JSON by counting braces
    const startIdx = response.indexOf('{')
    if (startIdx !== -1) {
      let braceCount = 0
      let endIdx = startIdx
      for (let i = startIdx; i < response.length; i++) {
        if (response[i] === '{') braceCount++
        else if (response[i] === '}') {
          braceCount--
          if (braceCount === 0) {
            endIdx = i + 1
            break
          }
        }
      }

      if (endIdx > startIdx) {
        jsonStr = response.slice(startIdx, endIdx)
      }
    }
  }

  if (!jsonStr) {
    throw new JsonParseError(
      `No JSON found in response (${response.length} chars). Preview: ${response.slice(0, 300)}...`,
      response,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch (e) {
    const parseErr = e as SyntaxError
    throw new JsonParseError(
      `JSON parse failed: ${parseErr.message}. Extracted: ${jsonStr.slice(0, 200)}...`,
      response,
    )
  }

  return validateOutput(parsed, schema, response)
}

/** parseMarkers extracts and validates field markers from an LLM response. */
export function parseMarkers<T>(
  response: string,
  schema: Record<string, FieldConfig>,
): T {
  const result: Record<string, unknown> = {}

  for (const [name, config] of Object.entries(schema)) {
    const marker = `[[ ## ${name} ## ]]`
    const idx = response.indexOf(marker)
    if (idx === -1) continue

    const start = idx + marker.length
    const nextMarker = response.indexOf('[[ ##', start)
    const end = nextMarker === -1 ? response.length : nextMarker
    const valueStr = response.slice(start, end).trim()

    result[name] = parseFieldValue(valueStr, config)
  }

  return validateOutput(result, schema, response)
}

/** parseFieldValue parses a string value based on the Zod type. */
function parseFieldValue(str: string, config: FieldConfig): unknown {
  const zodType = config.type

  // Handle arrays
  if (zodType instanceof z.ZodArray) {
    const jsonStart = str.indexOf('[')
    const jsonEnd = str.lastIndexOf(']') + 1
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(str.slice(jsonStart, jsonEnd))
      } catch {
        return []
      }
    }
    return []
  }

  // Handle numbers
  if (zodType instanceof z.ZodNumber) {
    const match = str.match(/[\d.]+/)
    return match ? parseFloat(match[0]) : 0
  }

  // Handle booleans
  if (zodType instanceof z.ZodBoolean) {
    return str.toLowerCase().startsWith('true')
  }

  // Handle objects
  if (zodType instanceof z.ZodObject) {
    const jsonStart = str.indexOf('{')
    const jsonEnd = str.lastIndexOf('}') + 1
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(str.slice(jsonStart, jsonEnd))
      } catch {
        return {}
      }
    }
    return {}
  }

  // Default: string (first line or entire content)
  const firstLine = str.split('\n')[0]?.trim()
  return firstLine ?? ''
}

/** validateOutput validates parsed data against the output schema. */
function validateOutput<T>(
  data: unknown,
  schema: Record<string, FieldConfig>,
  rawResponse: string,
): T {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, config] of Object.entries(schema)) {
    shape[name] = config.type
  }

  const zodSchema = z.object(shape)
  const result = zodSchema.safeParse(data)

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new ValidationError(
      `Output validation failed: ${issues}`,
      rawResponse,
      result.error,
    )
  }

  return result.data as T
}

/** parseJsonFromResponse is a simpler JSON parser without schema validation. */
export function parseJsonFromResponse<T = Record<string, unknown>>(
  response: string,
): T {
  // Try to find JSON in code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    const blockContent = codeBlockMatch[1].trim()
    try {
      return JSON.parse(blockContent) as T
    } catch {
      // Continue to try other methods
    }
  }

  // Try to find raw JSON object by counting braces
  const startIdx = response.indexOf('{')
  if (startIdx !== -1) {
    let braceCount = 0
    let endIdx = startIdx
    for (let i = startIdx; i < response.length; i++) {
      if (response[i] === '{') braceCount++
      else if (response[i] === '}') {
        braceCount--
        if (braceCount === 0) {
          endIdx = i + 1
          break
        }
      }
    }

    if (endIdx > startIdx) {
      const jsonStr = response.slice(startIdx, endIdx)
      try {
        return JSON.parse(jsonStr) as T
      } catch (e) {
        const parseErr = e as SyntaxError
        throw new JsonParseError(
          `JSON parse failed: ${parseErr.message}. Extracted: ${jsonStr.slice(0, 200)}...`,
          response,
        )
      }
    }
  }

  throw new JsonParseError(
    `No valid JSON found in response (${response.length} chars). Preview: ${response.slice(0, 300)}...`,
    response,
  )
}

/** parseFieldMarkers is a simpler field marker parser without schema validation. */
export function parseFieldMarkers(
  response: string,
  fields: { name: string; type: 'string' | 'int' | 'float' | 'list' }[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const { name, type } of fields) {
    const marker = `[[ ## ${name} ## ]]`
    const markerIdx = response.indexOf(marker)
    if (markerIdx === -1) continue

    const start = markerIdx + marker.length
    const nextMarker = response.indexOf('[[ ##', start)
    const end = nextMarker === -1 ? response.length : nextMarker
    const valueStr = response.slice(start, end).trim()

    try {
      if (type === 'list') {
        const jsonStart = valueStr.indexOf('[')
        const jsonEnd = valueStr.lastIndexOf(']') + 1
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          result[name] = JSON.parse(valueStr.slice(jsonStart, jsonEnd))
        } else {
          result[name] = []
        }
      } else if (type === 'int') {
        const match = valueStr.match(/\d+/)
        result[name] = match?.[0] ? parseInt(match[0], 10) : null
      } else if (type === 'float') {
        const match = valueStr.match(/[\d.]+/)
        result[name] = match ? parseFloat(match[0]) : null
      } else {
        const firstLine = valueStr.split('\n')[0]
        result[name] = firstLine?.trim() ?? ''
      }
    } catch {
      result[name] = null
    }
  }

  return result
}

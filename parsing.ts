/**
 * DSTS SDK response parsing.
 *
 * Extracts and validates LLM responses using JSON or field marker formats.
 */

import { z } from 'zod'
import type { FieldConfig, FieldError, OutputFormat, TryParseResult } from './types.js'

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

/** ValidationError is thrown when Zod validation fails. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly zodError: z.ZodError,
    public readonly fieldErrors: FieldError[],
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** SchemaValidationError is thrown after schema correction attempts have been exhausted. */
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly fieldErrors: FieldError[],
    public readonly correctionAttempts: number,
  ) {
    super(message)
    this.name = 'SchemaValidationError'
  }
}

/** parseResponse parses and validates an LLM response. */
export function parseResponse<T>(
  response: string,
  outputSchema: Record<string, FieldConfig>,
  _format: OutputFormat,
): T {
  return parseJson(response, outputSchema)
}

/** tryParseResponse attempts to parse and returns detailed errors on failure. */
export function tryParseResponse<T>(
  response: string,
  outputSchema: Record<string, FieldConfig>,
  _format: OutputFormat,
): TryParseResult<T> {
  return tryParseJson(response, outputSchema)
}

/** tryParseJson attempts JSON parsing with detailed field error detection. */
export function tryParseJson<T>(
  response: string,
  schema: Record<string, FieldConfig>,
): TryParseResult<T> {
  // Extract JSON from response
  const jsonStr = extractJsonString(response)
  if (!jsonStr) {
    return {
      ok: false,
      errors: [{ path: '', message: 'No JSON found in response', expectedType: 'object' }],
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>
  } catch (e) {
    const parseErr = e as SyntaxError
    return {
      ok: false,
      errors: [{ path: '', message: `JSON parse failed: ${parseErr.message}`, expectedType: 'object' }],
    }
  }

  // Convert null to undefined for optional fields (common LLM behavior)
  parsed = convertNullToUndefined(parsed)

  // Build Zod schema and validate
  const shape: Record<string, z.ZodType> = {}
  for (const [name, config] of Object.entries(schema)) {
    shape[name] = config.type
  }
  const zodSchema = z.object(shape)
  const result = zodSchema.safeParse(parsed)

  if (result.success) {
    return { ok: true, data: result.data as T, json: parsed }
  }

  // Convert Zod errors to FieldErrors with similar field detection
  const errors = zodErrorsToFieldErrors(result.error, schema, parsed)
  return { ok: false, errors, json: parsed }
}

/** zodErrorsToFieldErrors converts Zod errors to FieldErrors with similar field detection. */
function zodErrorsToFieldErrors(
  zodError: z.ZodError,
  schema: Record<string, FieldConfig>,
  parsed: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = []
  const schemaKeys = Object.keys(schema)

  for (const issue of zodError.issues) {
    const path = issue.path.join('.')
    const expectedType = getExpectedType(issue, schema)

    // Check for similar field names (typos, different casing, etc.)
    const fieldName = issue.path[0] as string
    let foundField: string | undefined
    let foundValue: unknown

    // Check if field is missing (received undefined)
    const isMissing = issue.code === 'invalid_type' && 
      (issue as { received?: string }).received === 'undefined'
    
    if (isMissing) {
      // Field is missing - look for similar field names in parsed data
      const similar = findSimilarField(fieldName, parsed, schemaKeys)
      if (similar) {
        foundField = similar
        foundValue = parsed[similar]
      }
    }

    errors.push({
      path,
      message: issue.message,
      expectedType,
      foundField,
      foundValue,
    })
  }

  return errors
}

/** findSimilarField looks for fields that might be typos or alternatives. */
function findSimilarField(
  expectedField: string,
  parsed: Record<string, unknown>,
  schemaKeys: string[],
): string | undefined {
  const parsedKeys = Object.keys(parsed)
  const extraKeys = parsedKeys.filter((k) => !schemaKeys.includes(k))

  // Common field name variations
  const variations: Record<string, string[]> = {
    issue_type: ['type', 'issueType', 'issue', 'kind', 'category'],
    segment_index: ['index', 'segmentIndex', 'segment_idx', 'idx'],
    timestamp_sec: ['timestamp', 'time', 'time_sec', 'seconds', 'timestampSec'],
    why_awkward: ['description', 'reason', 'explanation', 'why'],
    ideal_state: ['suggestion', 'suggested', 'fix', 'recommendation'],
    severity: ['priority', 'level', 'importance'],
  }

  // Check known variations
  const knownVariations = variations[expectedField]
  if (knownVariations) {
    for (const v of knownVariations) {
      if (extraKeys.includes(v)) return v
    }
  }

  // Check for similar names (simple edit distance heuristic)
  const normalized = expectedField.toLowerCase().replace(/_/g, '')
  for (const key of extraKeys) {
    const normalizedKey = key.toLowerCase().replace(/_/g, '')
    if (normalizedKey === normalized) return key
    if (normalizedKey.includes(normalized) || normalized.includes(normalizedKey)) return key
  }

  return undefined
}

/** getExpectedType extracts a human-readable type description from a Zod issue. */
function getExpectedType(issue: z.ZodIssue, schema: Record<string, FieldConfig>): string {
  const fieldName = issue.path[0] as string
  const fieldConfig = schema[fieldName]

  if (fieldConfig) {
    return zodTypeToString(fieldConfig.type)
  }

  if (issue.code === 'invalid_type') {
    return issue.expected
  }

  return 'unknown'
}

/** zodTypeToString converts a Zod type to a readable string for prompts. */
export function zodTypeToString(zodType: z.ZodType): string {
  // Use instanceof checks with proper Zod class methods where available
  if (zodType instanceof z.ZodString) {
    const desc = zodType.description
    return desc ? `string (${desc})` : 'string'
  }
  if (zodType instanceof z.ZodNumber) return 'number'
  if (zodType instanceof z.ZodBoolean) return 'boolean'
  if (zodType instanceof z.ZodEnum) {
    // ZodEnum has .options property in v3/v4
    const opts = (zodType as unknown as { options?: readonly string[] }).options
    if (opts && opts.length > 0) {
      return `enum[${opts.map((v) => `"${v}"`).join(', ')}]`
    }
    // Fallback to _def
    const def = (zodType as unknown as { _def?: { values?: readonly string[] } })._def
    const values = def?.values ?? []
    if (values.length > 0) {
      return `enum[${values.map((v) => `"${v}"`).join(', ')}]`
    }
    return 'enum'
  }
  if (zodType instanceof z.ZodArray) {
    // ZodArray has .element property
    const elem = (zodType as unknown as { element?: z.ZodType }).element
    if (elem) {
      return `array<${zodTypeToString(elem)}>`
    }
    return 'array'
  }
  if (zodType instanceof z.ZodObject) {
    // ZodObject has .shape property
    const shapeObj = (zodType as unknown as { shape?: Record<string, z.ZodType> }).shape
    if (shapeObj) {
      const fields = Object.keys(shapeObj).slice(0, 3).join(', ')
      return `object{${fields}${Object.keys(shapeObj).length > 3 ? ', ...' : ''}}`
    }
    return 'object'
  }
  if (zodType instanceof z.ZodOptional) {
    // ZodOptional has .unwrap() method
    const unwrapped = (zodType as unknown as { unwrap?: () => z.ZodType }).unwrap?.()
    if (unwrapped) {
      return `optional<${zodTypeToString(unwrapped)}>`
    }
    return 'optional'
  }
  if (zodType instanceof z.ZodNullable) {
    const unwrapped = (zodType as unknown as { unwrap?: () => z.ZodType }).unwrap?.()
    if (unwrapped) {
      return `nullable<${zodTypeToString(unwrapped)}>`
    }
    return 'nullable'
  }
  if (zodType instanceof z.ZodDefault) {
    // ZodDefault wraps inner type
    const inner = (zodType as unknown as { _def?: { innerType?: z.ZodType } })._def?.innerType
    if (inner) {
      return `default<${zodTypeToString(inner)}>`
    }
    return 'default'
  }
  return 'unknown'
}

/** extractJsonString finds and extracts JSON from a response string. */
export function extractJsonString(response: string): string | null {
  // Try to find JSON in code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim()
  }

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
      return response.slice(startIdx, endIdx)
    }
  }

  return null
}

/** buildPatchPrompt creates a prompt asking for a jq-style patch for a field error. */
export function buildPatchPrompt(
  error: FieldError,
  currentJson: Record<string, unknown>,
  _schema: Record<string, FieldConfig>,
): string {
  const lines: string[] = []

  lines.push('Your JSON output has a schema error that needs correction.')
  lines.push('')
  lines.push(`Field: "${error.path}"`)
  lines.push(`Issue: ${error.message}`)
  lines.push(`Expected type: ${error.expectedType}`)

  if (error.foundField) {
    lines.push(`Found similar field: "${error.foundField}" with value: ${JSON.stringify(error.foundValue)}`)
  }

  lines.push('')
  lines.push('Current JSON (abbreviated):')
  lines.push('```json')
  lines.push(JSON.stringify(abbreviateJson(currentJson), null, 2))
  lines.push('```')
  lines.push('')
  lines.push('Respond with ONLY a jq-style patch to fix this field. Examples:')
  lines.push('- .field_name = "value"')
  lines.push('- .field_name = 123')
  lines.push('- .field_name = .other_field')
  lines.push('- del(.wrong_field) | .correct_field = "value"')
  lines.push('')
  lines.push('Your patch:')

  return lines.join('\n')
}

/** buildBatchPatchPrompt creates a prompt asking for jq-style patches for multiple errors at once. */
export function buildBatchPatchPrompt(
  errors: FieldError[],
  currentJson: Record<string, unknown>,
): string {
  const lines: string[] = []

  lines.push('Your JSON output has schema errors that need correction.')
  lines.push('')
  lines.push('ERRORS:')
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i]!
    lines.push(`${i + 1}. Field "${error.path}": ${error.message} (expected: ${error.expectedType})`)
    if (error.foundField) {
      lines.push(`   Found similar: "${error.foundField}" = ${JSON.stringify(error.foundValue)}`)
    }
  }

  lines.push('')
  lines.push('Current JSON (abbreviated):')
  lines.push('```json')
  lines.push(JSON.stringify(abbreviateJson(currentJson), null, 2))
  lines.push('```')
  lines.push('')
  lines.push('Respond with jq-style patches to fix ALL errors. Use | to chain multiple patches.')
  lines.push('Examples:')
  lines.push('- .field1 = "value" | .field2 = 123')
  lines.push('- .items[0].name = .items[0].title | del(.items[0].title)')
  lines.push('- .changes[2].rationale = .changes[2].reason')
  lines.push('')
  lines.push('Your patches (one line, pipe-separated):')

  return lines.join('\n')
}

/** abbreviateJson truncates large values for display in prompts. */
function abbreviateJson(obj: Record<string, unknown>, maxLength = 100): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length <= 2) {
        result[key] = value
      } else {
        result[key] = [...value.slice(0, 2), `... (${value.length - 2} more)`]
      }
    } else if (typeof value === 'string' && value.length > maxLength) {
      result[key] = value.slice(0, maxLength) + '...'
    } else if (typeof value === 'object' && value !== null) {
      result[key] = abbreviateJson(value as Record<string, unknown>, maxLength)
    } else {
      result[key] = value
    }
  }

  return result
}

/** convertNullToUndefined recursively converts null values to undefined (for optional fields). */
function convertNullToUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      // Skip null values (converts to undefined/missing)
      continue
    }
    if (Array.isArray(value)) {
      // For arrays, recursively process objects but keep nulls as-is to preserve indices
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return convertNullToUndefined(item as Record<string, unknown>)
        }
        return item
      })
    } else if (typeof value === 'object') {
      result[key] = convertNullToUndefined(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

/** extractPatch extracts a jq-style patch from an LLM response. */
export function extractPatch(response: string): string {
  // Look for a line that starts with a dot (jq field reference)
  const lines = response.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('.') || trimmed.startsWith('del(')) {
      return trimmed
    }
  }

  // If no clear patch found, try the whole response (minus markdown)
  const cleaned = response.replace(/```[^`]*```/g, '').trim()
  const firstLine = cleaned.split('\n')[0]?.trim()
  if (firstLine && (firstLine.startsWith('.') || firstLine.startsWith('del('))) {
    return firstLine
  }

  return response.trim()
}

/** applyJqPatch applies a jq-style patch to a JSON object using the actual jq tool. */
export function applyJqPatch(
  obj: Record<string, unknown>,
  patch: string,
): Record<string, unknown> {
  // Validate patch format - only allow safe jq operations
  // Allow: field access (.foo), array indexing ([0]), assignment (=), deletion (del()), pipes (|)
  // Disallow: shell commands, $ENV, input/inputs, @base64d, system, etc.
  const unsafePatterns = [
    /\$ENV/i,
    /\$__loc__/i,
    /\binput\b/,
    /\binputs\b/,
    /\bsystem\b/,
    /\@base64d/,
    /\@uri/,
    /\@csv/,
    /\@tsv/,
    /\@json/,
    /\@text/,
    /\@sh/,
    /`[^`]*`/, // Backtick string interpolation
    /\bimport\b/,
    /\binclude\b/,
    /\bdebug\b/,
    /\berror\b/,
    /\bhalt\b/,
    /\$/,  // Any variable reference (safest to disallow all)
  ]

  for (const pattern of unsafePatterns) {
    if (pattern.test(patch)) {
      console.error(`  Unsafe jq pattern detected, skipping patch: ${patch}`)
      return obj
    }
  }

  // Only allow patches that look like field operations
  // Valid: .foo = "bar", .items[0].name = .items[0].title, del(.foo) | .bar = 1
  const safePattern = /^[\s\w\[\]."'=|,:\-{}]*$/
  if (!safePattern.test(patch)) {
    console.error(`  Invalid characters in patch, skipping: ${patch}`)
    return obj
  }

  try {
    const input = JSON.stringify(obj)
    // Pass patch as argument (not shell-interpolated) - Bun.spawnSync uses execve directly
    const result = Bun.spawnSync(['jq', '--', patch], {
      stdin: Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      console.error(`  jq error: ${stderr}`)
      return obj
    }

    const output = result.stdout.toString().trim()
    return JSON.parse(output) as Record<string, unknown>
  } catch (e) {
    console.error(`  jq execution failed: ${e}`)
    return obj
  }
}

/** parseJson extracts and validates JSON from an LLM response. */
export function parseJson<T>(
  response: string,
  schema: Record<string, FieldConfig>,
): T {
  const result = tryParseJson<T>(response, schema)
  if (result.ok && result.data) {
    return result.data
  }

  const errors = result.errors ?? []
  if (errors.length > 0 && errors[0]?.message.includes('JSON parse failed')) {
    throw new JsonParseError(errors[0].message, response)
  }
  if (errors.length > 0 && errors[0]?.message.includes('No JSON found')) {
    throw new JsonParseError(errors[0].message, response)
  }

  // Validation error
  const shape: Record<string, z.ZodType> = {}
  for (const [name, config] of Object.entries(schema)) {
    shape[name] = config.type
  }
  const zodSchema = z.object(shape)
  const zodResult = zodSchema.safeParse(result.json)

  if (!zodResult.success) {
    const issues = zodResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ValidationError(`Output validation failed: ${issues}`, response, zodResult.error, errors)
  }

  // Shouldn't reach here
  throw new JsonParseError('Unknown parse error', response)
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

/**
 * ocpipe response parsing.
 *
 * Extracts and validates LLM responses using JSON or field marker formats.
 */

import { z } from 'zod/v4'
import type { FieldConfig, FieldError, TryParseResult } from './types.js'

/** JSON Patch operation (RFC 6902). */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  path: string
  value?: unknown
  from?: string
}

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
): T {
  return parseJson(response, outputSchema)
}

/** tryParseResponse attempts to parse and returns detailed errors on failure. */
export function tryParseResponse<T>(
  response: string,
  outputSchema: Record<string, FieldConfig>,
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
      errors: [
        {
          path: '',
          message: 'No JSON found in response',
          expectedType: 'object',
        },
      ],
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>
  } catch (e) {
    const parseErr = e as SyntaxError
    return {
      ok: false,
      errors: [
        {
          path: '',
          message: `JSON parse failed: ${parseErr.message}`,
          expectedType: 'object',
        },
      ],
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
    const isMissing =
      issue.code === 'invalid_type' &&
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
    if (
      normalizedKey.includes(normalized) ||
      normalized.includes(normalizedKey)
    )
      return key
  }

  return undefined
}

/** getExpectedType extracts a human-readable type description from a Zod issue. */
function getExpectedType(
  issue: z.ZodIssue,
  schema: Record<string, FieldConfig>,
): string {
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
    const def = (
      zodType as unknown as { _def?: { values?: readonly string[] } }
    )._def
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
    const shapeObj = (
      zodType as unknown as { shape?: Record<string, z.ZodType> }
    ).shape
    if (shapeObj) {
      const fields = Object.keys(shapeObj).slice(0, 3).join(', ')
      return `object{${fields}${Object.keys(shapeObj).length > 3 ? ', ...' : ''}}`
    }
    return 'object'
  }
  if (zodType instanceof z.ZodOptional) {
    // ZodOptional has .unwrap() method
    const unwrapped = (
      zodType as unknown as { unwrap?: () => z.ZodType }
    ).unwrap?.()
    if (unwrapped) {
      return `optional<${zodTypeToString(unwrapped)}>`
    }
    return 'optional'
  }
  if (zodType instanceof z.ZodNullable) {
    const unwrapped = (
      zodType as unknown as { unwrap?: () => z.ZodType }
    ).unwrap?.()
    if (unwrapped) {
      return `nullable<${zodTypeToString(unwrapped)}>`
    }
    return 'nullable'
  }
  if (zodType instanceof z.ZodDefault) {
    // ZodDefault wraps inner type
    const inner = (zodType as unknown as { _def?: { innerType?: z.ZodType } })
      ._def?.innerType
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
    lines.push(
      `Found similar field: "${error.foundField}" with value: ${JSON.stringify(error.foundValue)}`,
    )
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
    lines.push(
      `${i + 1}. Field "${error.path}": ${error.message} (expected: ${error.expectedType})`,
    )
    if (error.foundField) {
      lines.push(
        `   Found similar: "${error.foundField}" = ${JSON.stringify(error.foundValue)}`,
      )
    }
  }

  lines.push('')
  lines.push('Current JSON (abbreviated):')
  lines.push('```json')
  lines.push(JSON.stringify(abbreviateJson(currentJson), null, 2))
  lines.push('```')
  lines.push('')
  lines.push(
    'Respond with jq-style patches to fix ALL errors. Use | to chain multiple patches.',
  )
  lines.push('Examples:')
  lines.push('- .field1 = "value" | .field2 = 123')
  lines.push('- .items[0].name = .items[0].title | del(.items[0].title)')
  lines.push('- .changes[2].rationale = .changes[2].reason')
  lines.push('')
  lines.push('Your patches (one line, pipe-separated):')

  return lines.join('\n')
}

/** abbreviateJson truncates large values for display in prompts. */
function abbreviateJson(
  obj: Record<string, unknown>,
  maxLength = 100,
): Record<string, unknown> {
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
function convertNullToUndefined(
  obj: Record<string, unknown>,
): Record<string, unknown> {
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
  if (
    firstLine &&
    (firstLine.startsWith('.') || firstLine.startsWith('del('))
  ) {
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
    /@base64d/,
    /@uri/,
    /@csv/,
    /@tsv/,
    /@json/,
    /@text/,
    /@sh/,
    /`[^`]*`/, // Backtick string interpolation
    /\bimport\b/,
    /\binclude\b/,
    /\bdebug\b/,
    /\berror\b/,
    /\bhalt\b/,
    /\$/, // Any variable reference (safest to disallow all)
  ]

  for (const pattern of unsafePatterns) {
    if (pattern.test(patch)) {
      console.error(`  Unsafe jq pattern detected, skipping patch: ${patch}`)
      return obj
    }
  }

  // Only allow patches that look like field operations
  // Valid: .foo = "bar", .items[0].name = .items[0].title, del(.foo) | .bar = 1
  const safePattern = /^[\s\w[\]."'=|,:\-{}]*$/
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

// ============================================================================
// JSON Patch (RFC 6902) Support
// ============================================================================

/** buildJsonPatchPrompt creates a prompt asking for RFC 6902 JSON Patch operations. */
export function buildJsonPatchPrompt(
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
    lines.push(
      `Found similar field: "${error.foundField}" with value: ${JSON.stringify(error.foundValue)}`,
    )
  }

  lines.push('')
  lines.push('Current JSON (abbreviated):')
  lines.push('```json')
  lines.push(JSON.stringify(abbreviateJson(currentJson), null, 2))
  lines.push('```')
  lines.push('')
  lines.push(
    'Respond with ONLY a JSON Patch array (RFC 6902) to fix this field. Examples:',
  )
  lines.push('- [{"op": "add", "path": "/field_name", "value": "new_value"}]')
  lines.push('- [{"op": "replace", "path": "/field_name", "value": 123}]')
  lines.push(
    '- [{"op": "move", "from": "/wrong_field", "path": "/correct_field"}]',
  )
  lines.push(
    '- [{"op": "remove", "path": "/wrong_field"}, {"op": "add", "path": "/correct_field", "value": "..."}]',
  )
  lines.push('')
  lines.push('Your JSON Patch:')

  return lines.join('\n')
}

/** buildBatchJsonPatchPrompt creates a prompt asking for JSON Patch operations for multiple errors. */
export function buildBatchJsonPatchPrompt(
  errors: FieldError[],
  currentJson: Record<string, unknown>,
): string {
  const lines: string[] = []

  lines.push('Your JSON output has schema errors that need correction.')
  lines.push('')
  lines.push('ERRORS:')
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i]!
    lines.push(
      `${i + 1}. Field "${error.path}": ${error.message} (expected: ${error.expectedType})`,
    )
    if (error.foundField) {
      lines.push(
        `   Found similar: "${error.foundField}" = ${JSON.stringify(error.foundValue)}`,
      )
    }
  }

  lines.push('')
  lines.push('Current JSON (abbreviated):')
  lines.push('```json')
  lines.push(JSON.stringify(abbreviateJson(currentJson), null, 2))
  lines.push('```')
  lines.push('')
  lines.push(
    'Respond with a JSON Patch array (RFC 6902) to fix ALL errors. Examples:',
  )
  lines.push('- [{"op": "move", "from": "/type", "path": "/issue_type"}]')
  lines.push('- [{"op": "replace", "path": "/items/0/name", "value": "fixed"}]')
  lines.push('- [{"op": "add", "path": "/missing_field", "value": "default"}]')
  lines.push('')
  lines.push('Your JSON Patch array:')

  return lines.join('\n')
}

/**
 * extractBalancedArray extracts a balanced JSON array from a string starting at startIdx.
 * Returns the array substring or null if not found/unbalanced.
 */
function extractBalancedArray(text: string, startIdx: number): string | null {
  if (startIdx === -1 || startIdx >= text.length) return null

  let bracketCount = 0
  let endIdx = startIdx
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '[') bracketCount++
    else if (text[i] === ']') {
      bracketCount--
      if (bracketCount === 0) {
        endIdx = i + 1
        break
      }
    }
  }

  if (endIdx > startIdx && bracketCount === 0) {
    return text.slice(startIdx, endIdx)
  }
  return null
}

/** extractJsonPatch extracts a JSON Patch array from an LLM response. */
export function extractJsonPatch(response: string): JsonPatchOperation[] {
  // Try to find JSON array in code blocks first
  // Use indexOf to find code block boundaries to avoid ReDoS vulnerabilities
  const codeBlockStart = response.indexOf('```')
  if (codeBlockStart !== -1) {
    const codeBlockEnd = response.indexOf('```', codeBlockStart + 3)
    if (codeBlockEnd !== -1) {
      const codeBlockContent = response.slice(codeBlockStart + 3, codeBlockEnd)
      // Skip optional "json" language identifier and whitespace
      const arrayStart = codeBlockContent.indexOf('[')
      if (arrayStart !== -1) {
        const arrayJson = extractBalancedArray(codeBlockContent, arrayStart)
        if (arrayJson) {
          try {
            return JSON.parse(arrayJson) as JsonPatchOperation[]
          } catch {
            // Continue to try other methods
          }
        }
      }
    }
  }

  // Try to find raw JSON array by counting brackets
  const arrayJson = extractBalancedArray(response, response.indexOf('['))
  if (arrayJson) {
    try {
      return JSON.parse(arrayJson) as JsonPatchOperation[]
    } catch {
      // Fall through to empty array
    }
  }

  console.error(
    `  Could not extract JSON Patch from response: ${response.slice(0, 100)}...`,
  )
  return []
}

/** toJsonPointer converts a dot-notation path to JSON Pointer format. */
function toJsonPointer(path: string): string {
  if (path.startsWith('/')) return path
  if (path === '') return ''
  // Convert dot notation to JSON Pointer
  // e.g., "items.0.name" -> "/items/0/name"
  return '/' + path.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
}

/** applyJsonPatch applies RFC 6902 JSON Patch operations to an object. */
export function applyJsonPatch(
  obj: Record<string, unknown>,
  operations: JsonPatchOperation[],
): Record<string, unknown> {
  let result = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>

  for (const op of operations) {
    const path = toJsonPointer(op.path)
    const pathParts = path.split('/').filter(Boolean)

    try {
      switch (op.op) {
        case 'add':
        case 'replace': {
          if (pathParts.length === 0) {
            // Replace entire document
            if (typeof op.value === 'object' && op.value !== null) {
              result = op.value as Record<string, unknown>
            }
          } else {
            setValueAtPath(result, pathParts, op.value)
          }
          break
        }
        case 'remove': {
          removeValueAtPath(result, pathParts)
          break
        }
        case 'move': {
          if (!op.from) break
          const fromPath = toJsonPointer(op.from)
          const fromParts = fromPath.split('/').filter(Boolean)
          const value = getValueAtPath(result, fromParts)
          removeValueAtPath(result, fromParts)
          setValueAtPath(result, pathParts, value)
          break
        }
        case 'copy': {
          if (!op.from) break
          const srcPath = toJsonPointer(op.from)
          const srcParts = srcPath.split('/').filter(Boolean)
          const srcValue = getValueAtPath(result, srcParts)
          setValueAtPath(
            result,
            pathParts,
            JSON.parse(JSON.stringify(srcValue)),
          )
          break
        }
        case 'test': {
          // Test operation - verify value matches, throw if not
          const actualValue = getValueAtPath(result, pathParts)
          if (JSON.stringify(actualValue) !== JSON.stringify(op.value)) {
            console.error(
              `  JSON Patch test failed: ${path} expected ${JSON.stringify(op.value)}, got ${JSON.stringify(actualValue)}`,
            )
          }
          break
        }
      }
    } catch (e) {
      console.error(
        `  JSON Patch operation failed: ${JSON.stringify(op)} - ${e}`,
      )
    }
  }

  return result
}

/** Keys that could be used for prototype pollution attacks. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key)
}

/**
 * Unescape a single JSON Pointer path segment according to RFC 6901.
 * This ensures that checks for dangerous keys are applied to the
 * effective property name, not the escaped form.
 */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * isSafePathSegment determines whether a JSON Pointer path segment is safe to use
 * as a property key on an object. It rejects keys that are known to enable
 * prototype pollution or that contain characters commonly used in special
 * property notations.
 */
function isSafePathSegment(segment: string): boolean {
  // Normalize the segment as it will appear as a property key.
  const normalized = unescapeJsonPointerSegment(String(segment))
  if (isUnsafeKey(normalized)) return false
  // Disallow bracket notation-style segments to avoid unexpected coercions.
  if (normalized.includes('[') || normalized.includes(']')) return false
  return true
}

/** getValueAtPath retrieves a value at a JSON Pointer path. */
function getValueAtPath(
  obj: Record<string, unknown>,
  parts: string[],
): unknown {
  let current: unknown = obj
  for (const part of parts) {
    // Block prototype-pollution: reject __proto__, constructor, prototype
    if (
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      return undefined
    }
    if (!isSafePathSegment(part)) return undefined
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10)
      current = current[idx]
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

/** setValueAtPath sets a value at a JSON Pointer path. */
function setValueAtPath(
  obj: Record<string, unknown>,
  parts: string[],
  value: unknown,
): void {
  if (parts.length === 0) return

  let current: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    // Block prototype-pollution: reject __proto__, constructor, prototype
    if (
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      return
    }
    if (!isSafePathSegment(part)) {
      // Avoid writing to dangerous or malformed prototype-related properties
      return
    }
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10)
      if (current[idx] === undefined) {
        // Create intermediate object or array
        const nextPart = parts[i + 1]!
        current[idx] = /^\d+$/.test(nextPart) ? [] : Object.create(null)
      }
      current = current[idx]
    } else if (typeof current === 'object' && current !== null) {
      const rec = current as Record<string, unknown>
      if (rec[part] === undefined) {
        const nextPart = parts[i + 1]!
        rec[part] = /^\d+$/.test(nextPart) ? [] : Object.create(null)
      }
      current = rec[part]
    }
  }

  const lastPart = parts[parts.length - 1]!
  // Block prototype-pollution: reject __proto__, constructor, prototype
  if (
    lastPart === '__proto__' ||
    lastPart === 'constructor' ||
    lastPart === 'prototype'
  ) {
    return
  }
  if (!isSafePathSegment(lastPart)) {
    // Avoid writing to dangerous or malformed prototype-related properties
    return
  }
  if (Array.isArray(current)) {
    const idx = parseInt(lastPart, 10)
    current[idx] = value
  } else if (typeof current === 'object' && current !== null) {
    ;(current as Record<string, unknown>)[lastPart] = value
  }
}

/** removeValueAtPath removes a value at a JSON Pointer path. */
function removeValueAtPath(
  obj: Record<string, unknown>,
  parts: string[],
): void {
  if (parts.length === 0) return

  let current: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    // Block prototype-pollution: reject __proto__, constructor, prototype
    if (
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      return
    }
    if (!isSafePathSegment(part)) {
      // Avoid accessing dangerous prototype-related properties
      return
    }
    if (Array.isArray(current)) {
      current = current[parseInt(part, 10)]
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return
    }
  }

  const lastPart = parts[parts.length - 1]!
  // Block prototype-pollution: reject __proto__, constructor, prototype
  if (
    lastPart === '__proto__' ||
    lastPart === 'constructor' ||
    lastPart === 'prototype'
  ) {
    return
  }
  if (!isSafePathSegment(lastPart)) {
    // Avoid deleting dangerous or malformed properties
    return
  }
  if (Array.isArray(current)) {
    const idx = parseInt(lastPart, 10)
    current.splice(idx, 1)
  } else if (typeof current === 'object' && current !== null) {
    delete (current as Record<string, unknown>)[lastPart]
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
    const issues = zodResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new ValidationError(
      `Output validation failed: ${issues}`,
      response,
      zodResult.error,
      errors,
    )
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

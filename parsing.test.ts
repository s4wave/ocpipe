import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  parseResponse,
  parseJson,
  parseMarkers,
  parseJsonFromResponse,
  parseFieldMarkers,
  JsonParseError,
  ValidationError,
} from './parsing.js'
import { field } from './signature.js'

describe('parseJson', () => {
  const schema = {
    name: field.string('name'),
    count: field.number('count'),
  }

  it('parses JSON from code block', () => {
    const response = `Here is the result:
\`\`\`json
{"name": "test", "count": 42}
\`\`\`
Done!`

    const result = parseJson<{ name: string; count: number }>(response, schema)
    expect(result).toEqual({ name: 'test', count: 42 })
  })

  it('parses raw JSON without code block', () => {
    const response = `Result: {"name": "test", "count": 42}`
    const result = parseJson<{ name: string; count: number }>(response, schema)
    expect(result).toEqual({ name: 'test', count: 42 })
  })

  it('handles nested JSON objects', () => {
    const nestedSchema = {
      data: field.object({ value: z.number() }),
    }
    const response = `{"data": {"value": 123}}`
    const result = parseJson<{ data: { value: number } }>(response, nestedSchema)
    expect(result).toEqual({ data: { value: 123 } })
  })

  it('throws JsonParseError when no JSON found', () => {
    expect(() => parseJson('no json here', schema)).toThrow(JsonParseError)
  })

  it('throws JsonParseError for invalid JSON', () => {
    expect(() => parseJson('{invalid json}', schema)).toThrow(JsonParseError)
  })

  it('throws ValidationError for schema mismatch', () => {
    const response = '{"name": 123, "count": "not a number"}'
    expect(() => parseJson(response, schema)).toThrow(ValidationError)
  })
})

describe('parseMarkers', () => {
  const schema = {
    name: field.string('name'),
    count: field.number('count'),
    tags: field.array(z.string()),
  }

  it('parses field markers', () => {
    const response = `[[ ## name ## ]]
John Doe

[[ ## count ## ]]
42

[[ ## tags ## ]]
["a", "b", "c"]

[[ ## completed ## ]]`

    const result = parseMarkers<{ name: string; count: number; tags: string[] }>(
      response,
      schema,
    )
    expect(result.name).toBe('John Doe')
    expect(result.count).toBe(42)
    expect(result.tags).toEqual(['a', 'b', 'c'])
  })

  it('handles missing fields gracefully', () => {
    const partialSchema = {
      name: field.string(),
    }
    const response = `[[ ## name ## ]]
Test

[[ ## completed ## ]]`

    const result = parseMarkers<{ name: string }>(response, partialSchema)
    expect(result.name).toBe('Test')
  })

  it('parses boolean values', () => {
    const boolSchema = {
      enabled: field.boolean(),
    }
    const response = `[[ ## enabled ## ]]
true

[[ ## completed ## ]]`

    const result = parseMarkers<{ enabled: boolean }>(response, boolSchema)
    expect(result.enabled).toBe(true)
  })

  it('returns default values for unparseable data', () => {
    const response = `[[ ## count ## ]]
not a number

[[ ## completed ## ]]`

    // When no digits found, returns 0 (lenient parsing)
    const result = parseMarkers<{ count: number }>(response, { count: field.number() })
    expect(result.count).toBe(0)
  })
})

describe('parseResponse', () => {
  const schema = {
    result: field.string(),
  }

  it('uses json format by default', () => {
    const response = '{"result": "hello"}'
    const result = parseResponse<{ result: string }>(response, schema, 'json')
    expect(result).toEqual({ result: 'hello' })
  })

  it('uses markers format when specified', () => {
    const response = `[[ ## result ## ]]
hello

[[ ## completed ## ]]`
    const result = parseResponse<{ result: string }>(response, schema, 'markers')
    expect(result).toEqual({ result: 'hello' })
  })
})

describe('parseJsonFromResponse (simple)', () => {
  it('extracts JSON from code block', () => {
    const response = `\`\`\`json
{"foo": "bar"}
\`\`\``
    const result = parseJsonFromResponse(response)
    expect(result).toEqual({ foo: 'bar' })
  })

  it('extracts raw JSON', () => {
    const response = 'Result: {"foo": "bar"}'
    const result = parseJsonFromResponse(response)
    expect(result).toEqual({ foo: 'bar' })
  })

  it('throws on no JSON', () => {
    expect(() => parseJsonFromResponse('no json')).toThrow(JsonParseError)
  })
})

describe('parseFieldMarkers (simple)', () => {
  it('parses string fields', () => {
    const response = `[[ ## name ## ]]
John

[[ ## completed ## ]]`
    const result = parseFieldMarkers(response, [{ name: 'name', type: 'string' }])
    expect(result.name).toBe('John')
  })

  it('parses int fields', () => {
    const response = `[[ ## count ## ]]
42

[[ ## completed ## ]]`
    const result = parseFieldMarkers(response, [{ name: 'count', type: 'int' }])
    expect(result.count).toBe(42)
  })

  it('parses float fields', () => {
    const response = `[[ ## score ## ]]
3.14

[[ ## completed ## ]]`
    const result = parseFieldMarkers(response, [{ name: 'score', type: 'float' }])
    expect(result.score).toBeCloseTo(3.14)
  })

  it('parses list fields', () => {
    const response = `[[ ## items ## ]]
["a", "b"]

[[ ## completed ## ]]`
    const result = parseFieldMarkers(response, [{ name: 'items', type: 'list' }])
    expect(result.items).toEqual(['a', 'b'])
  })
})

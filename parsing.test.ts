import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  parseResponse,
  parseJson,
  parseJsonFromResponse,
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

describe('parseResponse', () => {
  const schema = {
    result: field.string(),
  }

  it('parses JSON response', () => {
    const response = '{"result": "hello"}'
    const result = parseResponse<{ result: string }>(response, schema, 'json')
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

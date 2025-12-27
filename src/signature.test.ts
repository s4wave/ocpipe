import { describe, it, expect } from 'vitest'
import { z } from 'zod/v4'
import { signature, field, buildOutputSchema } from './signature.js'

describe('signature', () => {
  it('creates a signature definition', () => {
    const sig = signature({
      doc: 'Test signature',
      inputs: {
        text: field.string('Input text'),
      },
      outputs: {
        result: field.string('Output result'),
      },
    })

    expect(sig.doc).toBe('Test signature')
    expect(sig.inputs.text.desc).toBe('Input text')
    expect(sig.outputs.result.desc).toBe('Output result')
  })

  it('preserves Zod types for validation', () => {
    const sig = signature({
      doc: 'Test',
      inputs: {
        text: field.string(),
      },
      outputs: {
        count: field.number(),
        valid: field.boolean(),
      },
    })

    // Validate with Zod types
    expect(sig.outputs.count.type.parse(42)).toBe(42)
    expect(sig.outputs.valid.type.parse(true)).toBe(true)
    expect(() => sig.outputs.count.type.parse('not a number')).toThrow()
  })
})

describe('field helpers', () => {
  it('creates string field', () => {
    const f = field.string('description')
    expect(f.desc).toBe('description')
    expect(f.type.parse('hello')).toBe('hello')
  })

  it('creates number field', () => {
    const f = field.number('count')
    expect(f.desc).toBe('count')
    expect(f.type.parse(123)).toBe(123)
  })

  it('creates boolean field', () => {
    const f = field.boolean('flag')
    expect(f.desc).toBe('flag')
    expect(f.type.parse(false)).toBe(false)
  })

  it('creates array field', () => {
    const f = field.array(z.string(), 'list of strings')
    expect(f.desc).toBe('list of strings')
    expect(f.type.parse(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('creates object field', () => {
    const f = field.object({ name: z.string(), age: z.number() }, 'person')
    expect(f.desc).toBe('person')
    expect(f.type.parse({ name: 'John', age: 30 })).toEqual({
      name: 'John',
      age: 30,
    })
  })

  it('creates enum field', () => {
    const f = field.enum(['red', 'green', 'blue'] as const, 'color')
    expect(f.desc).toBe('color')
    expect(f.type.parse('red')).toBe('red')
    expect(() => f.type.parse('yellow')).toThrow()
  })

  it('creates optional field', () => {
    const f = field.optional(field.string('maybe'))
    expect(f.desc).toBe('maybe')
    expect(f.type.parse('hello')).toBe('hello')
    expect(f.type.parse(undefined)).toBeUndefined()
  })

  it('creates nullable field', () => {
    const f = field.nullable(field.string('nullable'))
    expect(f.desc).toBe('nullable')
    expect(f.type.parse('hello')).toBe('hello')
    expect(f.type.parse(null)).toBeNull()
  })

  it('creates custom field', () => {
    const customType = z.string().email()
    const f = field.custom(customType, 'email address')
    expect(f.desc).toBe('email address')
    expect(f.type.parse('test@example.com')).toBe('test@example.com')
    expect(() => f.type.parse('not-an-email')).toThrow()
  })
})

describe('buildOutputSchema', () => {
  it('builds a Zod object schema from field configs', () => {
    const outputs = {
      name: field.string('name'),
      age: field.number('age'),
      active: field.boolean('active'),
    }

    const schema = buildOutputSchema(outputs)

    const result = schema.parse({
      name: 'John',
      age: 30,
      active: true,
    })

    expect(result).toEqual({ name: 'John', age: 30, active: true })
  })

  it('validates all fields', () => {
    const outputs = {
      value: field.number(),
    }

    const schema = buildOutputSchema(outputs)

    expect(() => schema.parse({ value: 'not a number' })).toThrow()
  })
})

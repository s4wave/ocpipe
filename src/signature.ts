/**
 * DSTS SDK signature definition.
 *
 * Signatures declare input/output contracts for LLM interactions using Zod for validation.
 */

import { z } from 'zod/v4'
import type { FieldConfig, SignatureDef } from './types.js'

/** signature creates a new signature definition. */
export function signature<
  I extends Record<string, FieldConfig>,
  O extends Record<string, FieldConfig>,
>(def: { doc: string; inputs: I; outputs: O }): SignatureDef<I, O> {
  return def
}

/** field provides helper functions for creating common field configurations. */
export const field = {
  /** string creates a string field. */
  string: (desc?: string): FieldConfig<z.ZodString> => ({
    type: z.string(),
    desc,
  }),

  /** number creates a number field. */
  number: (desc?: string): FieldConfig<z.ZodNumber> => ({
    type: z.number(),
    desc,
  }),

  /** boolean creates a boolean field. */
  boolean: (desc?: string): FieldConfig<z.ZodBoolean> => ({
    type: z.boolean(),
    desc,
  }),

  /** array creates an array field with the specified item type. */
  array: <T extends z.ZodType>(
    itemType: T,
    desc?: string,
  ): FieldConfig<z.ZodArray<T>> => ({
    type: z.array(itemType),
    desc,
  }),

  /** object creates an object field with the specified shape. */
  object: <T extends z.ZodRawShape>(
    shape: T,
    desc?: string,
  ): FieldConfig<z.ZodObject<T>> => ({
    type: z.object(shape),
    desc,
  }),

  /** enum creates an enum field with the specified values. */
  enum: <const T extends readonly [string, ...string[]]>(
    values: T,
    desc?: string,
  ) => ({
    type: z.enum(values),
    desc,
  }),

  /** optional wraps a field type to make it optional. */
  optional: <T extends z.ZodType>(
    fieldConfig: FieldConfig<T>,
  ): FieldConfig<z.ZodOptional<T>> => ({
    type: fieldConfig.type.optional(),
    desc: fieldConfig.desc,
  }),

  /** nullable wraps a field type to make it nullable. */
  nullable: <T extends z.ZodType>(
    fieldConfig: FieldConfig<T>,
  ): FieldConfig<z.ZodNullable<T>> => ({
    type: fieldConfig.type.nullable(),
    desc: fieldConfig.desc,
  }),

  /** custom creates a field with a custom Zod type. */
  custom: <T extends z.ZodType>(type: T, desc?: string): FieldConfig<T> => ({
    type,
    desc,
  }),
}

/** buildOutputSchema creates a Zod object schema from output field definitions. */
export function buildOutputSchema<O extends Record<string, FieldConfig>>(
  outputs: O,
): z.ZodObject<{ [K in keyof O]: O[K]['type'] }> {
  const shape = {} as { [K in keyof O]: O[K]['type'] }
  for (const [key, config] of Object.entries(outputs)) {
    ;(shape as Record<string, z.ZodType>)[key] = config.type
  }
  return z.object(shape)
}

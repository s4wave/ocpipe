/**
 * ocpipe: LLM pipelines with OpenCode and Zod.
 *
 * Inspired by DSPy.
 *
 * @example
 * ```typescript
 * import { signature, field, module, Pipeline, createBaseState } from 'ocpipe'
 *
 * // Define a signature
 * const ParseIntent = signature({
 *   doc: 'Parse user intent from description',
 *   inputs: {
 *     description: field.string('User description'),
 *   },
 *   outputs: {
 *     intent: field.string('Parsed intent'),
 *     confidence: field.number('Confidence score'),
 *   },
 * })
 *
 * // Run in a pipeline
 * const pipeline = new Pipeline({
 *   name: 'my-workflow',
 *   defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
 *   defaultAgent: 'general',
 *   checkpointDir: './ckpt',
 *   logDir: './logs',
 * }, createBaseState)
 *
 * const result = await pipeline.run(module(ParseIntent), { description: 'Hello world' })
 * ```
 */

// Signature definition
export { signature, field, buildOutputSchema } from './signature.js'

// Predict class
export { Predict } from './predict.js'
export type { PredictConfig } from './predict.js'

// Module base class
export { Module, SignatureModule, module } from './module.js'

// Pipeline orchestrator
export { Pipeline } from './pipeline.js'

// State management
export { createSessionId, createBaseState, extendBaseState } from './state.js'

// Agent integration
export { runAgent, logStep } from './agent.js'

// Response parsing
export {
  parseResponse,
  parseJson,
  parseJsonFromResponse,
  tryParseResponse,
  tryParseJson,
  extractJsonString,
  // jq-style patches
  buildPatchPrompt,
  buildBatchPatchPrompt,
  extractPatch,
  applyJqPatch,
  // JSON Patch (RFC 6902)
  buildJsonPatchPrompt,
  buildBatchJsonPatchPrompt,
  extractJsonPatch,
  applyJsonPatch,
  zodTypeToString,
  JsonParseError,
  ValidationError,
  SchemaValidationError,
} from './parsing.js'
export type { JsonPatchOperation } from './parsing.js'

// Testing utilities
export {
  MockAgentBackend,
  createMockContext,
  generateMockOutputs,
} from './testing.js'
export type { MockResponse } from './testing.js'

// Types
export type {
  // Core types
  ModelConfig,
  ExecutionContext,
  StepResult,
  StepRecord,
  SubPipelineRecord,
  BaseState,
  PredictResult,
  // Signature types
  FieldConfig,
  SignatureDef,
  InferInputs,
  InferOutputs,
  // Pipeline types
  RetryConfig,
  PipelineConfig,
  RunOptions,
  // Agent types
  RunAgentOptions,
  RunAgentResult,
  // Correction types
  CorrectionMethod,
  CorrectionConfig,
  FieldError,
  TryParseResult,
} from './types.js'

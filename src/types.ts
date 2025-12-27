/**
 * DSTS SDK shared types.
 *
 * Core type definitions for the Declarative Self-Improving TypeScript SDK.
 */

import type { z } from 'zod/v4'

// ============================================================================
// Model Configuration
// ============================================================================

/** Model configuration for OpenCode. */
export interface ModelConfig {
  providerID: string
  modelID: string
}

// ============================================================================
// Execution Context
// ============================================================================

/** Execution context passed through pipeline execution. */
export interface ExecutionContext {
  /** Current OpenCode session ID (for continuity). */
  sessionId?: string
  /** Default model for predictions. */
  defaultModel: ModelConfig
  /** Default agent for predictions. */
  defaultAgent: string
  /** Timeout in seconds for agent calls. */
  timeoutSec: number
}

// ============================================================================
// Step Results
// ============================================================================

/** Result from a single pipeline step. */
export interface StepResult<T> {
  /** Parsed and validated output data. */
  data: T
  /** Step name for logging. */
  stepName: string
  /** Execution duration in milliseconds. */
  duration: number
  /** OpenCode session ID used. */
  sessionId: string
  /** Model used for this step. */
  model: ModelConfig
  /** Which retry attempt succeeded (1-based). */
  attempt: number
}

/** Record of a completed step for checkpointing. */
export interface StepRecord {
  stepName: string
  timestamp: string
  result: StepResult<unknown>
}

/** Record of a sub-pipeline execution. */
export interface SubPipelineRecord {
  name: string
  sessionId: string
  timestamp: string
  state: BaseState
}

// ============================================================================
// State
// ============================================================================

/** Base state interface for all pipeline states. */
export interface BaseState {
  /** Unique ID for this pipeline run. */
  sessionId: string
  /** ISO timestamp when pipeline started. */
  startedAt: string
  /** Current OpenCode session ID (for continuity). */
  opencodeSessionId?: string
  /** Current phase name (for resume). */
  phase: string
  /** All completed steps. */
  steps: StepRecord[]
  /** References to sub-pipelines. */
  subPipelines: SubPipelineRecord[]
}

// ============================================================================
// Predict Results
// ============================================================================

/** Result from a Predict.execute() call. */
export interface PredictResult<T> {
  /** Parsed and validated output data. */
  data: T
  /** Raw response text from the LLM. */
  raw: string
  /** OpenCode session ID. */
  sessionId: string
  /** Execution duration in milliseconds. */
  duration: number
  /** Model used. */
  model: ModelConfig
}

// ============================================================================
// Signature Types
// ============================================================================

/** Configuration for a signature field. */
export interface FieldConfig<T extends z.ZodType = z.ZodType> {
  /** Zod type for validation. */
  type: T
  /** Description of the field (used in prompt generation). */
  desc?: string
}

/** Signature definition with typed inputs and outputs. */
export interface SignatureDef<
  I extends Record<string, FieldConfig>,
  O extends Record<string, FieldConfig>,
> {
  /** Documentation/instruction for the LLM. */
  doc: string
  /** Input field definitions. */
  inputs: I
  /** Output field definitions. */
  outputs: O
}

/** Infer the input type from a signature definition. */
export type InferInputs<S extends SignatureDef<any, any>> =
  S extends SignatureDef<infer I, any> ?
    { [K in keyof I]: z.infer<I[K]['type']> }
  : never

/** Infer the output type from a signature definition. */
export type InferOutputs<S extends SignatureDef<any, any>> =
  S extends SignatureDef<any, infer O> ?
    { [K in keyof O]: z.infer<O[K]['type']> }
  : never

// ============================================================================
// Retry Configuration
// ============================================================================

/** Retry configuration for pipeline steps. */
export interface RetryConfig {
  /** Maximum number of attempts. */
  maxAttempts: number
  /** Whether to retry on parse errors (JSON failures). */
  onParseError?: boolean
}

// ============================================================================
// Schema Correction
// ============================================================================

/** Correction method for fixing schema validation errors. */
export type CorrectionMethod = 'json-patch' | 'jq'

/** Configuration for automatic schema correction on parse failures. */
export interface CorrectionConfig {
  /** Correction method to use (default: 'json-patch'). */
  method?: CorrectionMethod
  /** Use a different model for corrections (default: same model, same session). */
  model?: ModelConfig
  /** Maximum number of fields to attempt correcting per round (default: 5). */
  maxFields?: number
  /** Maximum number of correction rounds before giving up (default: 3). */
  maxRounds?: number
}

/** A field-level error from schema validation. */
export interface FieldError {
  /** The field path that failed (e.g., "issues.0.issue_type"). */
  path: string
  /** Human-readable error message. */
  message: string
  /** Expected type description. */
  expectedType: string
  /** If a similar field was found, its name. */
  foundField?: string
  /** The value found at the wrong field. */
  foundValue?: unknown
}

/** Result from trying to parse a response. */
export interface TryParseResult<T> {
  /** Whether parsing succeeded. */
  ok: boolean
  /** Parsed data if successful. */
  data?: T
  /** Field errors if validation failed. */
  errors?: FieldError[]
  /** The extracted JSON object (even if validation failed). */
  json?: Record<string, unknown>
}

// ============================================================================
// Pipeline Configuration
// ============================================================================

/** Configuration for a pipeline. */
export interface PipelineConfig {
  /** Pipeline name (used in checkpoints). */
  name: string
  /** Default model for predictions. */
  defaultModel: ModelConfig
  /** Default agent for predictions. */
  defaultAgent: string
  /** Directory for checkpoint files. */
  checkpointDir: string
  /** Directory for log files. */
  logDir: string
  /** Default retry configuration. */
  retry?: RetryConfig
  /** Default timeout in seconds. */
  timeoutSec?: number
}

/** Options for running a pipeline step. */
export interface RunOptions {
  /** Step name for logging (defaults to module class name). */
  name?: string
  /** Override model for this step. */
  model?: ModelConfig
  /** Start fresh session (don't reuse existing). */
  newSession?: boolean
  /** Override retry config for this step. */
  retry?: RetryConfig
}

// ============================================================================
// Agent Types
// ============================================================================

/** Options for running an OpenCode agent. */
export interface RunAgentOptions {
  /** The prompt to send to the agent. */
  prompt: string
  /** Agent type (e.g., "journey-creator", "explore", "general"). */
  agent: string
  /** Model to use. */
  model: ModelConfig
  /** Existing session ID to continue. */
  sessionId?: string
  /** Timeout in seconds. */
  timeoutSec?: number
}

/** Result from running an OpenCode agent. */
export interface RunAgentResult {
  /** The text response from the agent. */
  text: string
  /** Session ID (for continuing the conversation). */
  sessionId: string
}

/**
 * DSTS SDK Predict class.
 *
 * Executes a signature by generating a prompt, calling OpenCode, and parsing the response.
 */

import type {
  CorrectionConfig,
  ExecutionContext,
  FieldConfig,
  FieldError,
  InferInputs,
  InferOutputs,
  ModelConfig,
  PredictResult,
  SignatureDef,
} from './types.js'
import { runAgent } from './agent.js'
import {
  tryParseResponse,
  buildPatchPrompt,
  buildBatchPatchPrompt,
  extractPatch,
  applyJqPatch,
  zodTypeToString,
  SchemaValidationError,
} from './parsing.js'

/** Configuration for a Predict instance. */
export interface PredictConfig {
  /** Override the pipeline's default agent. */
  agent?: string
  /** Override the pipeline's default model. */
  model?: ModelConfig
  /** Start a fresh session (default: false, reuses context). */
  newSession?: boolean
  /** Custom prompt template function. */
  template?: (inputs: Record<string, unknown>) => string
  /** Schema correction options (enabled by default, set to false to disable). */
  correction?: CorrectionConfig | false
}

/** Predict executes a signature by calling an LLM and parsing the response. */
export class Predict<S extends SignatureDef<any, any>> {
  constructor(
    public readonly sig: S,
    public readonly config: PredictConfig = {},
  ) {}

  /** execute runs the prediction with the given inputs. */
  async execute(
    inputs: InferInputs<S>,
    ctx: ExecutionContext,
  ): Promise<PredictResult<InferOutputs<S>>> {
    const prompt = this.buildPrompt(inputs as Record<string, unknown>)
    const startTime = Date.now()

    const agentResult = await runAgent({
      prompt,
      agent: this.config.agent ?? ctx.defaultAgent,
      model: this.config.model ?? ctx.defaultModel,
      sessionId: this.config.newSession ? undefined : ctx.sessionId,
      timeoutSec: ctx.timeoutSec,
    })

    // Update context with new session ID for continuity
    ctx.sessionId = agentResult.sessionId

    const parseResult = tryParseResponse<InferOutputs<S>>(
      agentResult.text,
      this.sig.outputs,
    )

    // If parsing succeeded, return the result
    if (parseResult.ok && parseResult.data) {
      return {
        data: parseResult.data,
        raw: agentResult.text,
        sessionId: agentResult.sessionId,
        duration: Date.now() - startTime,
        model: this.config.model ?? ctx.defaultModel,
      }
    }

    // Parsing failed - attempt correction if enabled
    if (this.config.correction !== false && parseResult.errors && parseResult.json) {
      const corrected = await this.correctFields(
        parseResult.json,
        parseResult.errors,
        ctx,
        agentResult.sessionId,
      )

      if (corrected) {
        return {
          data: corrected,
          raw: agentResult.text,
          sessionId: agentResult.sessionId,
          duration: Date.now() - startTime,
          model: this.config.model ?? ctx.defaultModel,
        }
      }
    }

    // Correction failed or disabled - throw SchemaValidationError (non-retryable)
    const errors = parseResult.errors ?? []
    const errorMessages = errors.map((e) => `${e.path}: ${e.message}`).join('; ') || 'Unknown error'
    const correctionAttempts = this.config.correction !== false ? (typeof this.config.correction === 'object' ? this.config.correction.maxRounds ?? 3 : 3) : 0
    throw new SchemaValidationError(`Schema validation failed: ${errorMessages}`, errors, correctionAttempts)
  }

  /** correctFields attempts to fix field errors using same-session patches with retries. */
  private async correctFields(
    json: Record<string, unknown>,
    initialErrors: FieldError[],
    ctx: ExecutionContext,
    sessionId: string,
  ): Promise<InferOutputs<S> | null> {
    const correctionConfig = typeof this.config.correction === 'object' ? this.config.correction : {}
    const maxFields = correctionConfig.maxFields ?? 5
    const maxRounds = correctionConfig.maxRounds ?? 3
    const correctionModel = correctionConfig.model

    let currentJson = JSON.parse(JSON.stringify(json)) as Record<string, unknown>
    let currentErrors = initialErrors

    for (let round = 1; round <= maxRounds; round++) {
      const errorsToFix = currentErrors.slice(0, maxFields)
      
      if (errorsToFix.length === 0) {
        break
      }

      console.error(`\n>>> Correction round ${round}/${maxRounds}: fixing ${errorsToFix.length} field(s)...`)

      // Use batch prompt for multiple errors (more efficient)
      const patchPrompt = errorsToFix.length === 1
        ? buildPatchPrompt(errorsToFix[0]!, currentJson, this.sig.outputs)
        : buildBatchPatchPrompt(errorsToFix, currentJson)

      // Use same session (model has context) unless correction model specified
      const patchResult = await runAgent({
        prompt: patchPrompt,
        model: correctionModel ?? ctx.defaultModel,
        sessionId: correctionModel ? undefined : sessionId,
        agent: ctx.defaultAgent,
        timeoutSec: 60, // Short timeout for simple patches
      })

      // Extract and apply the patch (may be compound with |)
      const patch = extractPatch(patchResult.text)
      console.error(`  Patches: ${patch}`)
      currentJson = applyJqPatch(currentJson, patch)

      // Re-validate the corrected JSON - always use 'json' format since we have a JSON object now
      const revalidated = tryParseResponse<InferOutputs<S>>(
        JSON.stringify(currentJson),
        this.sig.outputs,
      )

      if (revalidated.ok && revalidated.data) {
        console.error(`  Schema correction successful after ${round} round(s)!`)
        return revalidated.data
      }

      // Update errors for next round
      currentErrors = revalidated.errors ?? []
      
      if (currentErrors.length === 0) {
        // No errors but also no data? Shouldn't happen, but handle gracefully
        console.error(`  Unexpected state: no errors but validation failed`)
        break
      }

      console.error(`  Round ${round} complete, ${currentErrors.length} error(s) remaining`)
    }

    console.error(`  Schema correction failed after ${maxRounds} rounds`)
    return null
  }

  /** buildPrompt generates the prompt from inputs. */
  private buildPrompt(inputs: Record<string, unknown>): string {
    // Allow custom template override
    if (this.config.template) {
      return this.config.template(inputs)
    }
    return this.generatePrompt(inputs)
  }

  /** generatePrompt creates a structured prompt from the signature and inputs. */
  private generatePrompt(inputs: Record<string, unknown>): string {
    const lines: string[] = []

    // Task description from signature doc
    lines.push(this.sig.doc)
    lines.push('')

    // Input fields
    lines.push('INPUTS:')
    for (const [name, config] of Object.entries(this.sig.inputs) as [
      string,
      FieldConfig,
    ][]) {
      const value = inputs[name]
      const desc = config.desc
      lines.push(`- ${name}${desc ? ` (${desc})` : ''}: ${JSON.stringify(value)}`)
    }
    lines.push('')

    // Output format with explicit schema
    lines.push('OUTPUT FORMAT:')
    lines.push('Return a JSON object with EXACTLY these field names and types.')
    lines.push('IMPORTANT: For optional fields, OMIT the field entirely - do NOT use null.')
    lines.push('')
    lines.push('```json')
    lines.push('{')
    const entries = Object.entries(this.sig.outputs) as [string, FieldConfig][]
    for (let i = 0; i < entries.length; i++) {
      const [name, config] = entries[i]!
      const typeStr = zodTypeToString(config.type)
      const desc = config.desc ? ` // ${config.desc}` : ''
      const comma = i < entries.length - 1 ? ',' : ''
      lines.push(`  "${name}": <${typeStr}>${comma}${desc}`)
    }
    lines.push('}')
    lines.push('```')

    return lines.join('\n')
  }
}

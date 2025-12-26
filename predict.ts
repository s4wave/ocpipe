/**
 * DSTS SDK Predict class.
 *
 * Executes a signature by generating a prompt, calling OpenCode, and parsing the response.
 */

import type {
  ExecutionContext,
  FieldConfig,
  InferInputs,
  InferOutputs,
  ModelConfig,
  OutputFormat,
  PredictResult,
  SignatureDef,
} from './types.js'
import { runAgent } from './agent.js'
import { parseResponse } from './parsing.js'

/** Configuration for a Predict instance. */
export interface PredictConfig {
  /** Output format for LLM response parsing (default: json). */
  format?: OutputFormat
  /** Override the pipeline's default agent. */
  agent?: string
  /** Override the pipeline's default model. */
  model?: ModelConfig
  /** Start a fresh session (default: false, reuses context). */
  newSession?: boolean
  /** Custom prompt template function. */
  template?: (inputs: Record<string, unknown>) => string
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

    const parsed = parseResponse<InferOutputs<S>>(
      agentResult.text,
      this.sig.outputs,
      this.config.format ?? 'json',
    )

    return {
      data: parsed,
      raw: agentResult.text,
      sessionId: agentResult.sessionId,
      duration: Date.now() - startTime,
      model: this.config.model ?? ctx.defaultModel,
    }
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

    // Output format
    if (this.config.format === 'markers') {
      lines.push('OUTPUT FORMAT - respond with these exact field markers:')
      lines.push('')
      for (const [name, config] of Object.entries(this.sig.outputs) as [
        string,
        FieldConfig,
      ][]) {
        const desc = config.desc
        lines.push(`[[ ## ${name} ## ]]`)
        lines.push(`(${desc || name})`)
        lines.push('')
      }
      lines.push('[[ ## completed ## ]]')
    } else {
      lines.push('OUTPUT FORMAT (JSON):')
      lines.push('{')
      for (const [name, config] of Object.entries(this.sig.outputs) as [
        string,
        FieldConfig,
      ][]) {
        const desc = config.desc
        lines.push(`  "${name}": ...,  // ${desc || ''}`)
      }
      lines.push('}')
    }

    return lines.join('\n')
  }
}

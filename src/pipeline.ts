/**
 * DSTS SDK Pipeline orchestrator.
 *
 * Manages execution context, state, checkpointing, logging, retry logic, and sub-pipelines.
 */

import { writeFile, readFile, readdir, mkdir } from 'fs/promises'
import type { Module } from './module.js'
import type {
  BaseState,
  ExecutionContext,
  PipelineConfig,
  RunOptions,
  StepResult,
} from './types.js'
import { logStep } from './agent.js'
import { JsonParseError, SchemaValidationError } from './parsing.js'

/** Pipeline orchestrates workflow execution with state management. */
export class Pipeline<S extends BaseState> {
  state: S
  private ctx: ExecutionContext
  private stepNumber = 0

  constructor(
    public readonly config: PipelineConfig,
    createState: () => S,
  ) {
    this.state = createState()
    this.ctx = {
      sessionId: undefined,
      defaultModel: config.defaultModel,
      defaultAgent: config.defaultAgent,
      timeoutSec: config.timeoutSec ?? 300,
    }
  }

  /** run executes a module and records the result. */
  async run<I, O>(
    module: Module<I, O>,
    input: I,
    options?: RunOptions,
  ): Promise<StepResult<O>> {
    const stepName = options?.name ?? module.constructor.name
    this.stepNumber++
    logStep(this.stepNumber, stepName)

    // Handle session control
    if (options?.newSession) {
      this.ctx.sessionId = undefined
    }

    // Handle model override
    const originalModel = this.ctx.defaultModel
    if (options?.model) {
      this.ctx.defaultModel = options.model
    }

    const startTime = Date.now()
    let lastError: Error | undefined
    const retryConfig = options?.retry ?? this.config.retry ?? { maxAttempts: 1 }

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        const data = await module.forward(input, this.ctx)

        // Restore original model
        this.ctx.defaultModel = originalModel

        const result: StepResult<O> = {
          data,
          stepName,
          duration: Date.now() - startTime,
          sessionId: this.ctx.sessionId ?? '',
          model: options?.model ?? this.config.defaultModel,
          attempt,
        }

        // Record step for checkpointing
        this.state.steps.push({
          stepName,
          timestamp: new Date().toISOString(),
          result: result as StepResult<unknown>,
        })

        // Update opencode session in state
        this.state.opencodeSessionId = this.ctx.sessionId

        await this.saveCheckpoint()
        return result
      } catch (err) {
        lastError = err as Error
        const isParseError = err instanceof JsonParseError
        const isSchemaError = err instanceof SchemaValidationError

        // Don't retry SchemaValidationError - corrections already attempted
        if (isSchemaError) {
          console.error(
            `Step ${stepName} failed with schema validation error (corrections exhausted): ${lastError.message}`,
          )
          break
        }

        if (
          attempt < retryConfig.maxAttempts &&
          (!isParseError || retryConfig.onParseError)
        ) {
          console.error(
            `Step ${stepName} failed (attempt ${attempt}/${retryConfig.maxAttempts}): ${lastError.message}`,
          )
          continue
        }
        break
      }
    }

    // Save checkpoint before throwing
    await this.saveCheckpoint()
    throw lastError
  }

  /** runSub executes a sub-pipeline with its own session. */
  async runSub<SS extends BaseState, T>(
    subConfig: PipelineConfig,
    createState: () => SS,
    executor: (sub: Pipeline<SS>) => Promise<T>,
  ): Promise<StepResult<T>> {
    this.stepNumber++
    logStep(this.stepNumber, `sub:${subConfig.name}`)

    const subPipeline = new Pipeline(subConfig, createState)
    const startTime = Date.now()

    const data = await executor(subPipeline)

    // Record sub-pipeline reference
    this.state.subPipelines.push({
      name: subConfig.name,
      sessionId: subPipeline.ctx.sessionId ?? '',
      timestamp: new Date().toISOString(),
      state: subPipeline.state,
    })

    await this.saveCheckpoint()

    return {
      data,
      stepName: `sub:${subConfig.name}`,
      duration: Date.now() - startTime,
      sessionId: subPipeline.ctx.sessionId ?? '',
      model: subConfig.defaultModel,
      attempt: 1,
    }
  }

  /** getSessionId returns the current OpenCode session ID. */
  getSessionId(): string | undefined {
    return this.ctx.sessionId
  }

  /** setPhase updates the current phase in state. */
  setPhase(phase: string): void {
    this.state.phase = phase
  }

  /** saveCheckpoint persists the current state to disk. */
  async saveCheckpoint(): Promise<void> {
    await mkdir(this.config.checkpointDir, { recursive: true })
    const path = `${this.config.checkpointDir}/${this.config.name}_${this.state.sessionId}.json`
    await writeFile(path, JSON.stringify(this.state, null, 2))
  }

  /** loadCheckpoint loads a pipeline from a checkpoint file. */
  static async loadCheckpoint<S extends BaseState>(
    config: PipelineConfig,
    sessionId: string,
  ): Promise<Pipeline<S> | null> {
    const path = `${config.checkpointDir}/${config.name}_${sessionId}.json`
    
    try {
      const content = await readFile(path, 'utf-8')
      const state = JSON.parse(content) as S
      const pipeline = new Pipeline<S>(config, () => state)
      pipeline.state = state

      // Restore context from state
      if (state.opencodeSessionId) {
        pipeline.ctx.sessionId = state.opencodeSessionId
      }

      // Restore step number
      pipeline.stepNumber = state.steps.length

      return pipeline
    } catch {
      return null
    }
  }

  /** listCheckpoints lists all checkpoint files for a pipeline name. */
  static async listCheckpoints(config: PipelineConfig): Promise<string[]> {
    try {
      const allFiles = await readdir(config.checkpointDir)
      const prefix = `${config.name}_`
      const files = allFiles
        .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
        .map((f) => `${config.checkpointDir}/${f}`)
      return files.sort().reverse() // Most recent first
    } catch {
      return []
    }
  }
}

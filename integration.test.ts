/**
 * DSTS SDK integration tests with real LLM.
 *
 * These tests use the github-copilot/grok-code-fast-1 model which is free.
 * Run with: bun run test -- src/dsts/integration.test.ts
 *
 * These tests are skipped by default in CI. To run locally:
 * DSTS_INTEGRATION=1 bun run test -- src/dsts/integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Predict } from './predict.js'
import { Module } from './module.js'
import { Pipeline } from './pipeline.js'
import { signature, field } from './signature.js'
import { createBaseState } from './state.js'
import { TMP_DIR } from '../paths.js'
import type { ExecutionContext, BaseState } from './types.js'
import { z } from 'zod'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'

// Skip these tests unless DSTS_INTEGRATION=1 is set
const runIntegration = process.env.DSTS_INTEGRATION === '1'

// Free model for testing
const GROK_MODEL = {
  providerID: 'github-copilot',
  modelID: 'grok-code-fast-1',
}

const testCheckpointDir = join(TMP_DIR, 'dsts-integration-test')

describe.skipIf(!runIntegration)('DSTS Integration', () => {
  beforeAll(async () => {
    await mkdir(testCheckpointDir, { recursive: true })
  })

  describe('Predict with real LLM', () => {
    it('executes a simple JSON signature', async () => {
      const ExtractInfoSig = signature({
        doc: 'Extract structured information from the given text. Return a JSON object.',
        inputs: {
          text: field.string('Text to analyze'),
        },
        outputs: {
          subject: field.string('Main subject of the text'),
          sentiment: field.enum(
            ['positive', 'negative', 'neutral'] as const,
            'Overall sentiment',
          ),
        },
      })

      const predict = new Predict(ExtractInfoSig, { format: 'json' })
      const ctx: ExecutionContext = {
        sessionId: undefined,
        defaultModel: GROK_MODEL,
        defaultAgent: 'general',
        timeoutSec: 60,
      }

      const result = await predict.execute(
        { text: 'I love this beautiful sunny day!' },
        ctx,
      )

      expect(result.data).toBeDefined()
      expect(typeof result.data.subject).toBe('string')
      expect(['positive', 'negative', 'neutral']).toContain(result.data.sentiment)
      expect(result.sessionId).toBeTruthy()
      expect(result.duration).toBeGreaterThan(0)
    }, 30000)

    it('executes a JSON format signature', async () => {
      const SummarizeSig = signature({
        doc: 'Summarize the text in one sentence.',
        inputs: {
          text: field.string('Text to summarize'),
        },
        outputs: {
          summary: field.string('One sentence summary'),
          wordCount: field.number('Approximate word count of original'),
        },
      })

      const predict = new Predict(SummarizeSig)
      const ctx: ExecutionContext = {
        sessionId: undefined,
        defaultModel: GROK_MODEL,
        defaultAgent: 'general',
        timeoutSec: 60,
      }

      const result = await predict.execute(
        {
          text: 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the alphabet.',
        },
        ctx,
      )

      expect(result.data.summary).toBeTruthy()
      expect(typeof result.data.wordCount).toBe('number')
    }, 30000)
  })

  describe('Module with real LLM', () => {
    it('executes a module with predictor', async () => {
      const ClassifySig = signature({
        doc: 'Classify the input as a question, statement, or command.',
        inputs: {
          text: field.string('Text to classify'),
        },
        outputs: {
          category: field.enum(
            ['question', 'statement', 'command'] as const,
            'Category',
          ),
          confidence: field.number('Confidence 0-100'),
        },
      })

      class TextClassifier extends Module<
        { text: string },
        { category: string; confidence: number }
      > {
        private classify = this.predict(ClassifySig, { model: GROK_MODEL })

        async forward(input: { text: string }, ctx: ExecutionContext) {
          const result = await this.classify.execute(input, ctx)
          return result.data
        }
      }

      const classifier = new TextClassifier()
      const ctx: ExecutionContext = {
        sessionId: undefined,
        defaultModel: GROK_MODEL,
        defaultAgent: 'general',
        timeoutSec: 60,
      }

      const result = await classifier.forward({ text: 'What time is it?' }, ctx)

      expect(result.category).toBe('question')
      expect(result.confidence).toBeGreaterThan(0)
    }, 30000)
  })

  describe('Pipeline with real LLM', () => {
    it('runs a full pipeline with checkpointing', async () => {
      // Define signatures
      const AnalyzeSig = signature({
        doc: 'Analyze the mood of the text.',
        inputs: {
          text: field.string('Text to analyze'),
        },
        outputs: {
          mood: field.string('Detected mood'),
          keywords: field.array(z.string(), 'Key words'),
        },
      })

      const SuggestSig = signature({
        doc: 'Suggest a response based on the mood.',
        inputs: {
          mood: field.string('The detected mood'),
        },
        outputs: {
          suggestion: field.string('Suggested response'),
        },
      })

      // Define modules
      class MoodAnalyzer extends Module<
        { text: string },
        { mood: string; keywords: string[] }
      > {
        private analyze = this.predict(AnalyzeSig)

        async forward(input: { text: string }, ctx: ExecutionContext) {
          const result = await this.analyze.execute(input, ctx)
          return result.data
        }
      }

      class ResponseSuggester extends Module<
        { mood: string },
        { suggestion: string }
      > {
        private suggest = this.predict(SuggestSig)

        async forward(input: { mood: string }, ctx: ExecutionContext) {
          const result = await this.suggest.execute(input, ctx)
          return result.data
        }
      }

      // Custom state
      interface AnalysisState extends BaseState {
        inputText: string
        mood?: string
        keywords?: string[]
        suggestion?: string
      }

      // Run pipeline
      const pipeline = new Pipeline<AnalysisState>(
        {
          name: 'mood-analysis',
          defaultModel: GROK_MODEL,
          defaultAgent: 'general',
          checkpointDir: testCheckpointDir,
          logDir: testCheckpointDir,
        },
        () => ({
          ...createBaseState(),
          inputText: '',
        }),
      )

      // Set input
      pipeline.state.inputText = 'I am so happy today!'

      // Step 1: Analyze mood
      const moodResult = await pipeline.run(new MoodAnalyzer(), {
        text: pipeline.state.inputText,
      })
      pipeline.state.mood = moodResult.data.mood
      pipeline.state.keywords = moodResult.data.keywords

      // Step 2: Suggest response
      const suggestionResult = await pipeline.run(new ResponseSuggester(), {
        mood: pipeline.state.mood,
      })
      pipeline.state.suggestion = suggestionResult.data.suggestion

      // Verify results
      expect(pipeline.state.mood).toBeTruthy()
      expect(pipeline.state.keywords).toBeInstanceOf(Array)
      expect(pipeline.state.suggestion).toBeTruthy()
      expect(pipeline.state.steps).toHaveLength(2)

      // Verify checkpointing
      const loadedPipeline = await Pipeline.loadCheckpoint<AnalysisState>(
        pipeline.config,
        pipeline.state.sessionId,
      )
      expect(loadedPipeline).not.toBeNull()
      expect(loadedPipeline?.state.mood).toBe(pipeline.state.mood)
    }, 60000)
  })

  // Cleanup
  describe.skip('Cleanup', () => {
    it('removes test checkpoint directory', async () => {
      await rm(testCheckpointDir, { recursive: true, force: true })
    })
  })
})

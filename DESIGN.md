# Design

ocpipe separates the **what** (Signatures declare input/output contracts), the **how** (Modules compose predictors), and the **when** (Pipelines orchestrate execution).

## Core Concepts

### Signatures

A Signature declares **what** an LLM interaction does - its inputs, outputs, and purpose.

```typescript
import { signature, field } from 'ocpipe'
import { z } from 'zod'

const AnalyzeCode = signature({
  doc: 'Analyze code for potential issues and improvements.',
  inputs: {
    code: field.string('Source code to analyze'),
    language: field.enum(['typescript', 'python', 'rust'] as const),
  },
  outputs: {
    issues: field.array(
      z.object({
        severity: z.enum(['error', 'warning', 'info']),
        message: z.string(),
        line: z.number(),
      }),
      'List of issues found',
    ),
    suggestions: field.array(z.string(), 'Improvement suggestions'),
    score: field.number('Code quality score 0-100'),
  },
})
```

**Field helpers:**

- `field.string(desc?)` - String field
- `field.number(desc?)` - Number field
- `field.boolean(desc?)` - Boolean field
- `field.array(itemType, desc?)` - Array field
- `field.object(shape, desc?)` - Object field
- `field.enum(values, desc?)` - Enum field
- `field.optional(field)` - Optional wrapper
- `field.nullable(field)` - Nullable wrapper
- `field.custom(zodType, desc?)` - Custom Zod type

### Predict

`Predict` bridges a Signature and OpenCode. It handles prompt generation, response parsing, and validation.

```typescript
import { Predict } from 'ocpipe'

const predict = new Predict(AnalyzeCode)
const result = await predict.execute(
  { code: '...', language: 'typescript' },
  ctx,
)

// With configuration
const predict = new Predict(AnalyzeCode, {
  agent: 'code-reviewer',
  model: { providerID: 'anthropic', modelID: 'claude-opus-4-5' },
  newSession: true,
  template: (inputs) => `...`,
})
```

### Module

A Module encapsulates a logical unit of work with one or more Predictors.

**SignatureModule** - For simple modules wrapping a single signature:

```typescript
import { SignatureModule } from 'ocpipe'

class IntentParser extends SignatureModule<typeof ParseIntent> {
  constructor() {
    super(ParseIntent)
  }

  async forward(input, ctx) {
    const result = await this.predictor.execute(input, ctx)
    return result.data
  }
}
```

**Module** - For complex modules with multiple predictors:

```typescript
import { Module } from 'ocpipe'

class CodeAnalyzer extends Module<
  { code: string; language: string },
  { issues: Issue[]; score: number }
> {
  private analyze = this.predict(AnalyzeCode)
  private suggest = this.predict(SuggestFixes, { agent: 'code-fixer' })

  async forward(input, ctx) {
    const analysis = await this.analyze.execute(input, ctx)

    if (analysis.data.issues.some((i) => i.severity === 'error')) {
      const fixes = await this.suggest.execute(
        {
          code: input.code,
          issues: analysis.data.issues,
        },
        ctx,
      )

      return {
        issues: analysis.data.issues,
        fixes: fixes.data.suggestions,
        score: analysis.data.score,
      }
    }

    return {
      issues: analysis.data.issues,
      score: analysis.data.score,
    }
  }
}
```

### Pipeline

Pipeline orchestrates execution with session management, checkpointing, logging, and retry logic.

```typescript
import { Pipeline, createBaseState } from 'ocpipe'

const pipeline = new Pipeline(
  {
    name: 'code-review',
    defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    defaultAgent: 'general',
    checkpointDir: './ckpt',
    logDir: './logs',
    retry: { maxAttempts: 2, onParseError: true },
    timeoutSec: 300,
  },
  createBaseState,
)

// Run modules
const result = await pipeline.run(new CodeAnalyzer(), {
  code: sourceCode,
  language: 'typescript',
})

// Run with step options
const result = await pipeline.run(new CodeAnalyzer(), input, {
  name: 'analyze-main',
  model: { providerID: 'anthropic', modelID: 'claude-opus-4-5' },
  newSession: true,
  retry: { maxAttempts: 3 },
})

// Access state
console.log(pipeline.state.steps)
console.log(pipeline.getSessionId())

// Resume from checkpoint
const resumed = await Pipeline.loadCheckpoint(config, sessionId)
```

### State Management

Automatic checkpointing after each step:

```typescript
import { createBaseState, extendBaseState } from 'ocpipe'

// Basic state
const state = createBaseState()
// { sessionId, startedAt, phase, steps, subPipelines }

// Extended state
interface MyState extends BaseState {
  inputPath: string
  results: AnalysisResult[]
}

const pipeline = new Pipeline(config, () => ({
  ...createBaseState(),
  inputPath: '/path/to/input',
  results: [],
}))
```

## Auto-Correction

Automatically corrects LLM schema mismatches using JSON Patch (RFC 6902):

```typescript
super(MySignature, {
  correction: {
    method: 'json-patch', // or 'jq'
    maxFields: 5,
    maxRounds: 3,
  },
})
```

The correction system:

1. Detects schema validation errors
2. Finds similar field names in the response
3. Asks the LLM for patches to fix errors
4. Applies patches and re-validates
5. Retries up to configured rounds

## Testing

Mock backends for unit testing without real LLM calls:

```typescript
import {
  MockAgentBackend,
  createMockContext,
  generateMockOutputs,
} from 'ocpipe'
import { vi } from 'vitest'

const mock = new MockAgentBackend()
mock.addJsonResponse({
  intent: 'greeting',
  confidence: 0.95,
  keywords: ['hello', 'world'],
})

vi.mock('./agent.js', () => ({
  runAgent: mock.createRunner(),
}))

const ctx = createMockContext({
  defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
})

// Auto-generate mock outputs from schema
const mockData = generateMockOutputs(ParseIntent.outputs)
```

## Why No ChainOfThought or ReAct?

Unlike DSPy, ocpipe does not provide `ChainOfThought` or `ReAct` variants:

- OpenCode agents already do chain-of-thought reasoning
- OpenCode agents already have tool access (ReAct)
- Adding these would duplicate functionality

Configure your OpenCode agent for tool access. The agent handles complexity; ocpipe structures the contract.

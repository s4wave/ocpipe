# ocpipe

<div align="center">
  <h3>OpenCode Pipeline</h3>
  <p>SDK for LLM pipelines with <a href="https://opencode.ai">OpenCode</a> and <a href="https://zod.dev">Zod</a>.</p>
  <p>
    <a href="https://github.com/s4wave/ocpipe">GitHub</a> |
    <a href="https://github.com/s4wave/ocpipe/blob/main/GETTING_STARTED.md">Getting Started</a> |
    <a href="https://github.com/s4wave/ocpipe/blob/main/LICENSE">MIT License</a>
  </p>
</div>

<div align="center">

```
Signature  →  Predict  →  Module  →  Pipeline
   │            │           │           │
 what        execute     compose    orchestrate
```

</div>

ocpipe separates the **what** (Signatures declare input/output contracts), the **how** (Modules compose predictors), and the **when** (Pipelines orchestrate execution). This separation enables clean composition, rich debugging, and maintainable LLM workflow code.

## Features

- **Type-safe signatures** - Define input/output contracts with Zod schemas
- **Automatic prompt generation** - Signatures become structured prompts
- **JSON output parsing** - Automatic extraction and validation of JSON responses
- **Session continuity** - Reuse OpenCode sessions across steps
- **Checkpointing** - Automatic state persistence after each step
- **Retry logic** - Configurable retries with parse error handling
- **Sub-pipelines** - Compose complex workflows from smaller pieces
- **Testing utilities** - Mock backends for unit testing

## Quick Start

```typescript
import { signature, field, SignatureModule, Pipeline, createBaseState } from 'ocpipe'
import { z } from 'zod'

// 1. Define a signature (the contract)
const ParseIntent = signature({
  doc: 'Parse user intent from a natural language description.',
  inputs: {
    description: field.string('User description in natural language'),
  },
  outputs: {
    intent: field.string('Parsed intent category'),
    confidence: field.number('Confidence score 0-1'),
    keywords: field.array(z.string(), 'Extracted keywords'),
  },
})

// 2. Create a module (the logic)
class IntentParser extends SignatureModule<typeof ParseIntent> {
  constructor() {
    super(ParseIntent)
  }

  async forward(input, ctx) {
    const result = await this.predictor.execute(input, ctx)
    return result.data  // Full signature output
  }
}

// 3. Run in a pipeline (the orchestration)
const pipeline = new Pipeline({
  name: 'my-workflow',
  defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
  defaultAgent: 'general',
  checkpointDir: './ckpt',
  logDir: './logs',
}, createBaseState)

const result = await pipeline.run(new IntentParser(), { description: 'Hello world' })
console.log(result.data.intent)
```

## Core Concepts

### Signatures

A Signature declares **what** an LLM interaction does - its inputs, outputs, and purpose. This is separate from *how* it executes.

```typescript
import { signature, field } from 'dsts'
import { z } from 'zod'

const AnalyzeCode = signature({
  doc: 'Analyze code for potential issues and improvements.',
  inputs: {
    code: field.string('Source code to analyze'),
    language: field.enum(['typescript', 'python', 'rust'] as const),
  },
  outputs: {
    issues: field.array(z.object({
      severity: z.enum(['error', 'warning', 'info']),
      message: z.string(),
      line: z.number(),
    }), 'List of issues found'),
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

`Predict` is the bridge between a Signature (the contract) and OpenCode (the execution). It handles prompt generation, response parsing, and validation.

```typescript
import { Predict } from 'dsts'

// Basic usage
const predict = new Predict(AnalyzeCode)
const result = await predict.execute({ code: '...', language: 'typescript' }, ctx)

// With configuration
const predict = new Predict(AnalyzeCode, {
  agent: 'code-reviewer',      // Override default agent
  model: { providerID: 'anthropic', modelID: 'claude-opus-4-5' },
  newSession: true,            // Don't reuse existing session
  template: (inputs) => `...`, // Custom prompt template
})
```

**Output format:**

The LLM is prompted to return a JSON object:
```
OUTPUT FORMAT:
Return a JSON object with EXACTLY these field names and types.

```json
{
  "issues": <array<object{severity, message, line}>>,  // List of issues found
  "suggestions": <array<string>>,  // Improvement suggestions
  "score": <number>  // Code quality score 0-100
}
```
```

### Module

A Module encapsulates a logical unit of work that may use one or more Predictors. Modules can call other Modules, enabling composition.

**SignatureModule** - For simple modules that wrap a single signature with pass-through types:

```typescript
import { SignatureModule } from 'dsts'

class IntentParser extends SignatureModule<typeof ParseIntent> {
  constructor() {
    super(ParseIntent)
  }

  async forward(input, ctx) {
    const result = await this.predictor.execute(input, ctx)
    return result.data  // Types inferred from ParseIntent
  }
}
```

**Module** - For complex modules with multiple predictors or transformed outputs:

```typescript
import { Module } from 'dsts'

class CodeAnalyzer extends Module<
  { code: string; language: string },
  { issues: Issue[]; score: number }
> {
  private analyze = this.predict(AnalyzeCode)
  private suggest = this.predict(SuggestFixes, { agent: 'code-fixer' })

  async forward(input: { code: string; language: string }, ctx: ExecutionContext) {
    // First, analyze the code
    const analysis = await this.analyze.execute(input, ctx)
    
    // If there are critical issues, get fix suggestions
    if (analysis.data.issues.some(i => i.severity === 'error')) {
      const fixes = await this.suggest.execute({
        code: input.code,
        issues: analysis.data.issues,
      }, ctx)
      
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

Pipeline is the top-level orchestrator. It manages execution context, state, checkpointing, logging, and retry logic.

```typescript
import { Pipeline, createBaseState } from 'dsts'

// Create pipeline with configuration
const pipeline = new Pipeline({
  name: 'code-review',
  defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
  defaultAgent: 'general',
  checkpointDir: './ckpt',
  logDir: './logs',
  retry: { maxAttempts: 2, onParseError: true },
  timeoutSec: 300,
}, createBaseState)

// Run modules
const result = await pipeline.run(new CodeAnalyzer(), {
  code: sourceCode,
  language: 'typescript',
})

// Run with step options
const result = await pipeline.run(new CodeAnalyzer(), input, {
  name: 'analyze-main',        // Custom step name
  model: { providerID: 'anthropic', modelID: 'claude-opus-4-5' },  // Override model
  newSession: true,            // Fresh session
  retry: { maxAttempts: 3 },   // Override retry
})

// Access state
console.log(pipeline.state.steps)        // Completed steps
console.log(pipeline.getSessionId())     // Current OpenCode session

// Resume from checkpoint
const resumed = await Pipeline.loadCheckpoint(config, sessionId)
```

### State Management

DSTS automatically checkpoints state after each step:

```typescript
import { createBaseState, extendBaseState } from 'dsts'

// Basic state
const state = createBaseState()
// { sessionId, startedAt, phase, steps, subPipelines }

// Extended state for your workflow
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

## Testing

DSTS provides testing utilities for unit testing without hitting real LLMs:

```typescript
import { MockAgentBackend, createMockContext, generateMockOutputs } from 'dsts'
import { vi } from 'vitest'

// Create mock backend
const mock = new MockAgentBackend()

// Add mock responses
mock.addJsonResponse({
  intent: 'greeting',
  confidence: 0.95,
  keywords: ['hello', 'world'],
})

// Mock the agent module
vi.mock('./agent.js', () => ({
  runAgent: mock.createRunner(),
}))

// Create test context
const ctx = createMockContext({
  defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
})

// Auto-generate mock outputs from schema
const mockData = generateMockOutputs(ParseIntent.outputs)
```

## Why Not ChainOfThought or ReAct?

Unlike DSPy, DSTS does not provide `ChainOfThought` or `ReAct` variants. This is intentional:

- **OpenCode agents already do chain-of-thought reasoning** - they think before acting
- **OpenCode agents already do ReAct** - they have access to tools and use them iteratively
- **Adding these would duplicate functionality** and create confusion

If you need tool access, configure your OpenCode agent appropriately. The agent handles the complexity; DSTS just structures the input/output contract.

## Requirements

- [Bun](https://bun.sh) runtime
- [OpenCode](https://opencode.ai) CLI installed and configured
- [Zod](https://zod.dev) for schema validation

## Installation

```bash
bun add ocpipe zod
```

## License

MIT - see [LICENSE](https://github.com/s4wave/ocpipe/blob/main/LICENSE) for details.

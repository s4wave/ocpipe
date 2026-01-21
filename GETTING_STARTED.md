# Getting Started with ocpipe

This guide walks you through building and running a simple "Hello World" application using ocpipe (OpenCode Pipeline).

**Repository:** https://github.com/s4wave/ocpipe

## Prerequisites

- [Bun](https://bun.sh) runtime
- [OpenCode](https://opencode.ai) CLI installed and configured

## Installation

```bash
bun add ocpipe zod
```

## Quick Start with REPL

The fastest way to explore ocpipe is with `bun repl`:

```bash
bun repl
```

Then paste this:

```typescript
import { signature, field, module, Pipeline, createBaseState } from 'ocpipe'

const Greet = signature({
  doc: 'Generate a friendly greeting for the given name.',
  inputs: { name: field.string('The name of the person to greet') },
  outputs: {
    greeting: field.string('A friendly greeting message'),
    emoji: field.string('An appropriate emoji for the greeting'),
  },
})

const pipeline = new Pipeline(
  {
    name: 'repl-demo',
    defaultModel: { providerID: 'opencode', modelID: 'minimax-m2.1-free' },
    defaultAgent: 'default',
  },
  createBaseState,
)

const result = await pipeline.run(module(Greet), { name: 'World' })
console.log(result.data.greeting, result.data.emoji)
```

You'll see the pipeline execute and print something like:

```
Hello, World! It's wonderful to meet you! :wave:
```

## Running the Example

The `example/` directory contains a complete hello world application. Run it directly:

```bash
bun run example/index.ts
```

This will:

1. Create a pipeline with default configuration
2. Send a greeting request to the LLM
3. Print the generated greeting and emoji

**Expected output:**

```
============================================================
STEP 1: Greeter
============================================================

>>> OpenCode [code] [opencode/minimax-m2.1-free] [new session]: Generate a friendly greeting for the given name...

<<< OpenCode done (85 chars) [session:abc123]

=== Result ===
Greeting: Hello, World! It's wonderful to meet you!
Emoji: :wave:
```

**Tip:** You can view what the agent did by running `opencode` to open the OpenCode UI, then typing `/sessions` to see the session list. Find the session ID from the output above and select it to see the full conversation.

## Understanding the Example

The example has three files that demonstrate ocpipe's core concepts:

### 1. Signature (`signature.ts`)

A **Signature** declares the contract between your code and the LLM. It defines:

- `doc`: Instructions for the LLM
- `inputs`: What data you provide
- `outputs`: What data you expect back

```typescript
import { signature, field } from '../index.js'

export const Greet = signature({
  doc: 'Generate a friendly greeting for the given name.',
  inputs: {
    name: field.string('The name of the person to greet'),
  },
  outputs: {
    greeting: field.string('A friendly greeting message'),
    emoji: field.string('An appropriate emoji for the greeting'),
  },
})
```

### 2. Module (`module.ts`)

A **Module** wraps a signature with execution logic. `SignatureModule` is a convenience class that automatically creates a predictor from your signature:

```typescript
import { SignatureModule } from '../index.js'
import { Greet } from './signature.js'

export class Greeter extends SignatureModule<typeof Greet> {
  constructor() {
    super(Greet)
  }

  async forward(input: { name: string }, ctx: ExecutionContext) {
    const result = await this.predictor.execute(input, ctx)
    return result.data
  }
}
```

### 3. Pipeline (`index.ts`)

A **Pipeline** orchestrates execution, managing sessions, checkpoints, and retries:

```typescript
import { Pipeline, createBaseState } from '../index.js'
import { Greeter } from './module.js'

const pipeline = new Pipeline(
  {
    name: 'hello-world',
    defaultModel: { providerID: 'opencode', modelID: 'minimax-m2.1-free' },
    defaultAgent: 'default',
    checkpointDir: './ckpt',
    logDir: './logs',
  },
  createBaseState,
)

const result = await pipeline.run(new Greeter(), { name: 'World' })
console.log(result.data.greeting)
```

## Modifying the Example

Let's extend the example to generate both a greeting and a farewell.

### Step 1: Add a new signature

Create `farewell-signature.ts`:

```typescript
import { signature, field } from '../index.js'

export const Farewell = signature({
  doc: 'Generate a friendly farewell for the given name.',
  inputs: {
    name: field.string('The name of the person to bid farewell'),
    context: field.string(
      'The context of the farewell (e.g., "end of meeting", "going on vacation")',
    ),
  },
  outputs: {
    farewell: field.string('A friendly farewell message'),
    emoji: field.string('An appropriate emoji for the farewell'),
  },
})
```

### Step 2: Add a new module

Create `farewell-module.ts`:

```typescript
import { SignatureModule } from '../index.js'
import type { ExecutionContext } from '../types.js'
import { Farewell } from './farewell-signature.js'

export class Fareweller extends SignatureModule<typeof Farewell> {
  constructor() {
    super(Farewell)
  }

  async forward(
    input: { name: string; context: string },
    ctx: ExecutionContext,
  ) {
    const result = await this.predictor.execute(input, ctx)
    return result.data
  }
}
```

### Step 3: Run both modules in sequence

Update `index.ts`:

```typescript
import { Pipeline, createBaseState } from '../index.js'
import { Greeter } from './module.js'
import { Fareweller } from './farewell-module.js'

async function main() {
  const pipeline = new Pipeline(
    {
      name: 'hello-goodbye',
      defaultModel: { providerID: 'opencode', modelID: 'minimax-m2.1-free' },
      defaultAgent: 'default',
      checkpointDir: './ckpt',
      logDir: './logs',
    },
    createBaseState,
  )

  // Run greeter
  const greeting = await pipeline.run(new Greeter(), { name: 'Alice' })
  console.log(`\nGreeting: ${greeting.data.greeting} ${greeting.data.emoji}`)

  // Run fareweller (reuses the same session for context)
  const farewell = await pipeline.run(new Fareweller(), {
    name: 'Alice',
    context: 'end of meeting',
  })
  console.log(`Farewell: ${farewell.data.farewell} ${farewell.data.emoji}`)
}

main().catch(console.error)
```

### Step 4: Run it

```bash
bun run example/index.ts
```

## Auto-Correction Example

ocpipe automatically corrects schema mismatches using patches when the LLM returns incorrect field names. Run the correction demo:

```bash
bun run example/correction.ts
```

This example uses field names that LLMs sometimes get wrong:

- `issue_type` (LLMs may return `type`)
- `severity` (LLMs may return `priority`)
- `explanation` (LLMs may return `description` or `reason`)
- `suggested_tags` (LLMs may return `tags`)

**Note:** Modern LLMs like Claude often follow the schema correctly. The correction system is a safety net for when they don't. You may not see correction rounds if the LLM gets it right the first time.

If the LLM does return incorrect field names, you'll see correction rounds:

```
>>> Correction round 1/3 [json-patch]: fixing 2 field(s)...
  JSON Patch: [{"op":"move","from":"/type","path":"/issue_type"},{"op":"move","from":"/priority","path":"/severity"}]
  Round 1 complete, 0 error(s) remaining
  Schema correction successful after 1 round(s)!
```

The correction system:

1. Validates the LLM's response against the output schema
2. If validation fails, identifies which fields have errors
3. Asks the LLM to generate patches to fix the errors
4. Applies patches and re-validates
5. Retries up to 3 rounds if needed

### Correction Methods

ocpipe supports two correction methods:

| Method                 | Format               | Requirements           |
| ---------------------- | -------------------- | ---------------------- |
| `json-patch` (default) | RFC 6902 JSON Patch  | None (pure TypeScript) |
| `jq`                   | jq-style expressions | `jq` binary installed  |

**JSON Patch** is the default because it requires no external dependencies and uses a standardized format that LLMs are familiar with from API documentation.

To use jq instead:

```typescript
super(MySignature, {
  correction: {
    method: 'jq', // Use jq-style patches (requires jq binary)
  },
})
```

To disable auto-correction:

```typescript
super(MySignature, { correction: false })
```

Full configuration options:

```typescript
super(MySignature, {
  correction: {
    method: 'json-patch', // 'json-patch' (default) or 'jq'
    maxFields: 5, // Max fields to fix per round
    maxRounds: 3, // Max correction attempts
  },
})
```

## Key Concepts

### Session Continuity

By default, ocpipe reuses the OpenCode session across pipeline steps. This means the LLM maintains context between calls. Use `newSession: true` in run options to start fresh:

```typescript
await pipeline.run(module, input, { newSession: true })
```

### Checkpointing

ocpipe automatically saves state after each step to `checkpointDir`. Resume from a checkpoint:

```typescript
const resumed = await Pipeline.loadCheckpoint(config, sessionId)
```

### Field Types

ocpipe provides field helpers for common types:

```typescript
field.string('description') // string
field.number('description') // number
field.boolean('description') // boolean
field.array(z.string(), 'description') // string[]
field.object({ key: z.string() }) // { key: string }
field.enum(['a', 'b'] as const) // 'a' | 'b'
field.optional(field.string()) // string | undefined
```

### Type Inference

Use `InferInputs` and `InferOutputs` to extract TypeScript types from a signature:

```typescript
import { signature, field, InferInputs, InferOutputs } from 'ocpipe'

const Greet = signature({
  doc: 'Generate a greeting.',
  inputs: { name: field.string('Name to greet') },
  outputs: { greeting: field.string('The greeting message') },
})

// Extract types from the signature
type GreetInputs = InferInputs<typeof Greet> // { name: string }
type GreetOutputs = InferOutputs<typeof Greet> // { greeting: string }

// Use in functions
function processGreeting(input: GreetInputs): void {
  console.log(`Processing greeting for: ${input.name}`)
}
```

This is useful for typing function parameters, return types, or when building generic utilities around signatures.

### Complex Modules

For modules with multiple predictors or transformed outputs, use the base `Module` class:

```typescript
import { Module } from '../index.js'

class ComplexModule extends Module<
  { input: string },
  { result: string; metadata: object }
> {
  private step1 = this.predict(Signature1)
  private step2 = this.predict(Signature2, { agent: 'specialist' })

  async forward(input, ctx) {
    const r1 = await this.step1.execute(input, ctx)
    const r2 = await this.step2.execute({ data: r1.data }, ctx)
    return { result: r2.data.output, metadata: r1.data }
  }
}
```

## Next Steps

- Read the full [README.md](./README.md) for advanced features
- Check the test files (`*.test.ts`) for more usage examples
- Explore `testing.ts` for unit testing without real LLM calls

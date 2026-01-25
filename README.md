<p align="center"><strong>ocpipe</strong></p>
<p align="center">Build LLM pipelines with <a href="https://github.com/sst/opencode">OpenCode</a>, <a href="https://github.com/anthropics/claude-code">Claude Code</a>, and <a href="https://zod.dev">Zod</a>.</p>
<p align="center">Inspired by <a href="https://github.com/stanfordnlp/dspy">DSPy</a>.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ocpipe"><img alt="npm" src="https://img.shields.io/npm/v/ocpipe?style=flat-square" /></a>
  <a href="https://github.com/s4wave/ocpipe/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/s4wave/ocpipe/tests.yml?style=flat-square&branch=master" /></a>
</p>

---

- **Type-safe** Define inputs and outputs with Zod schemas
- **Modular** Compose modules into complex pipelines
- **Checkpoints** Resume from any step
- **Multi-backend** Choose between OpenCode (75+ providers) or Claude Code SDK
- **Auto-correction** Fixes schema mismatches automatically

### Quick Start

```bash
bun add ocpipe
```

```typescript
import { signature, field, module, Pipeline, createBaseState } from 'ocpipe'

const Greet = signature({
  doc: 'Generate a friendly greeting for the given name.',
  inputs: { name: field.string('The name of the person to greet') },
  outputs: { greeting: field.string('A friendly greeting message') },
})

const pipeline = new Pipeline(
  {
    name: 'hello-world',
    defaultModel: { providerID: 'opencode', modelID: 'minimax-m2.1-free' },
    defaultAgent: 'default',
  },
  createBaseState,
)

const result = await pipeline.run(module(Greet), { name: 'World' })
console.log(result.data.greeting)

// Extract types from signatures
import { InferInputs, InferOutputs } from 'ocpipe'
type GreetIn = InferInputs<typeof Greet> // { name: string }
type GreetOut = InferOutputs<typeof Greet> // { greeting: string }
```

### Backends

ocpipe supports two backends for running LLM agents:

**OpenCode** (default) - Requires `opencode` CLI in your PATH. Supports 75+ providers.

```typescript
const pipeline = new Pipeline(
  {
    name: 'my-pipeline',
    defaultModel: {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
    },
    defaultAgent: 'default',
  },
  createBaseState,
)
```

**Claude Code** - Uses `@anthropic-ai/claude-agent-sdk`. Install as a peer dependency.

```typescript
// modelID: 'opus', 'sonnet', or 'haiku'
defaultModel: { backend: 'claude-code', modelID: 'sonnet' },
// permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
claudeCode: { permissionMode: 'acceptEdits' },
```

### Requirements

**For OpenCode backend:** Currently requires [this OpenCode fork](https://github.com/paralin/opencode). Once the following PRs are merged, the official release will work:

- [#5426](https://github.com/anomalyco/opencode/pull/5426) - Adds `--prompt-file` flag
- [#5339](https://github.com/anomalyco/opencode/pull/5339) - Session export fixes

**For Claude Code backend:** Install the SDK as a peer dependency:

```bash
bun add @anthropic-ai/claude-agent-sdk
```

### Documentation

- [Getting Started](./GETTING_STARTED.md) - Tutorial with examples
- [Design](./DESIGN.md) - Architecture and concepts
- [Contributing](./CONTRIBUTING.md) - Development setup

<!-- This code has been tested on animals. They didn't understand it either. -->

---

[Discord](https://discord.gg/opencode) · [OpenCode](https://github.com/sst/opencode)

<sub>An [Aperture Robotics](https://github.com/aperturerobotics) project.</sub>

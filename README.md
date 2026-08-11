<p align="center"><strong>ocpipe</strong></p>
<p align="center">Build LLM pipelines with Oh My Pi, OpenCode, Claude Code, Codex, Pi, and <a href="https://zod.dev">Zod</a>.</p>
<p align="center">Inspired by <a href="https://github.com/stanfordnlp/dspy">DSPy</a>.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ocpipe"><img alt="npm" src="https://img.shields.io/npm/v/ocpipe?style=flat-square" /></a>
  <a href="https://github.com/s4wave/ocpipe/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/s4wave/ocpipe/tests.yml?style=flat-square&branch=master" /></a>
</p>

---

- **Type-safe** Define inputs and outputs with Zod schemas
- **Modular** Compose modules into complex pipelines
- **Checkpoints** Resume from any step
- **Multi-backend** Choose between Prime Agent, Oh My Pi, OpenCode, Claude Code SDK, Codex SDK, or Pi
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
    defaultModel: { backend: 'omp', modelID: 'gpt-5.5' },
    checkpointDir: './ckpt',
    logDir: './logs',
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

ocpipe supports six backends for running LLM prompts:

**Prime Agent** - Uses the `prime-agent` CLI in headless JSON print mode and preserves sessions between pipeline steps.

```typescript
defaultModel: { backend: 'prime', modelID: '' },
prime: { command: '/path/to/prime-agent.sh', thinking: 'high' },
```

**Oh My Pi** (default) - Uses the `omp` CLI in headless JSON print mode.

```typescript
const pipeline = new Pipeline(
  {
    name: 'my-pipeline',
    defaultModel: { backend: 'omp', modelID: 'gpt-5.5' },
    omp: { command: 'omp', approvalMode: 'yolo', thinking: 'high' },
  },
  createBaseState,
)
```

**OpenCode** - Uses the `opencode` CLI. ocpipe passes prompt files directly and does not create or reference `.opencode/agents` definitions.

```typescript
defaultModel: { backend: 'opencode', providerID: 'anthropic', modelID: 'claude-sonnet-4' },
opencode: { command: 'opencode' },
```

**Claude Code** - Uses `@anthropic-ai/claude-agent-sdk`. Install as a peer dependency.

```typescript
// modelID: 'opus', 'sonnet', or 'haiku'
defaultModel: { backend: 'claude-code', modelID: 'sonnet' },
// permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
claudeCode: { permissionMode: 'acceptEdits' },
```

**Codex** - Uses `@openai/codex-sdk`. Install as a peer dependency.

```typescript
defaultModel: { backend: 'codex', modelID: 'gpt-5.4' },
codex: { sandbox: 'read-only', reasoningEffort: 'high' },
```

**Pi** - Uses the `pi` coding-agent CLI JSONL RPC mode.

```typescript
defaultModel: { backend: 'pi', modelID: 'gemma' },
pi: { command: 'pi' },
```

### Requirements

**For Prime Agent:** Install `prime-agent` or configure `prime.command`, then authenticate its provider.

**For Oh My Pi:** Install the `omp` CLI and authenticate the models it uses.

**For OpenCode backend:** Install the `opencode` CLI and authenticate the providers it uses. ocpipe does not require a `.opencode` directory.

**For Claude Code backend:** Install the SDK as a peer dependency:

```bash
bun add @anthropic-ai/claude-agent-sdk
```

**For Codex backend:** Install the Codex SDK package as a peer dependency:

```bash
bun add @openai/codex-sdk
```

### Documentation

- [Getting Started](./GETTING_STARTED.md) - Tutorial with examples
- [Design](./DESIGN.md) - Architecture and concepts
- [Contributing](./CONTRIBUTING.md) - Development setup

<!-- This code has been tested on animals. They didn't understand it either. -->

---

[Oh My Pi](https://github.com/aperturerobotics/oh-my-pi) · [OpenCode](https://github.com/sst/opencode)

<sub>An [Aperture Robotics](https://github.com/aperturerobotics) project.</sub>

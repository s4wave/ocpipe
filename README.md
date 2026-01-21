<p align="center"><strong>ocpipe</strong></p>
<p align="center">Build LLM pipelines with <a href="https://github.com/sst/opencode">OpenCode</a> and <a href="https://zod.dev">Zod</a>.</p>
<p align="center">Inspired by <a href="https://github.com/stanfordnlp/dspy">DSPy</a>.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ocpipe"><img alt="npm" src="https://img.shields.io/npm/v/ocpipe?style=flat-square" /></a>
  <a href="https://github.com/s4wave/ocpipe/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/s4wave/ocpipe/tests.yml?style=flat-square&branch=master" /></a>
</p>

---

- **Type-safe** Define inputs and outputs with Zod schemas
- **Modular** Compose modules into complex pipelines
- **Checkpoints** Resume from any step
- **Multi-model** Works with 75+ providers through OpenCode
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

OpenCode CLI is bundled — run `bun run opencode` or use your system `opencode` if installed.

### Documentation

- [Getting Started](./GETTING_STARTED.md) - Tutorial with examples
- [Design](./DESIGN.md) - Architecture and concepts
- [Contributing](./CONTRIBUTING.md) - Development setup

<!-- This code has been tested on animals. They didn't understand it either. -->

---

[Discord](https://discord.gg/opencode) · [OpenCode](https://github.com/sst/opencode)

<sub>An [Aperture Robotics](https://github.com/aperturerobotics) project.</sub>

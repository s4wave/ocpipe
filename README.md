<p align="center"><strong>ocpipe</strong></p>
<p align="center">SDK for LLM pipelines with <a href="https://github.com/sst/opencode">OpenCode</a> and <a href="https://zod.dev">Zod</a>.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ocpipe"><img alt="npm" src="https://img.shields.io/npm/v/ocpipe?style=flat-square" /></a>
  <a href="https://github.com/s4wave/ocpipe/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/s4wave/ocpipe/tests.yml?style=flat-square&branch=master" /></a>
</p>

---

### Quick Start

```typescript
import { signature, field, module, Pipeline, createBaseState } from 'ocpipe'

const Greet = signature({
  doc: 'Generate a friendly greeting for the given name.',
  inputs: {
    name: field.string('The name of the person to greet'),
  },
  outputs: {
    greeting: field.string('A friendly greeting message'),
    emoji: field.string('An appropriate emoji for the greeting'),
  },
})

const pipeline = new Pipeline(
  {
    name: 'hello-world',
    defaultModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
    defaultAgent: 'code',
    checkpointDir: './ckpt',
    logDir: './logs',
  },
  createBaseState,
)

const result = await pipeline.run(module(Greet), { name: 'World' })
console.log(result.data.greeting) // "Hello, World! It's wonderful to meet you!"
```

### Installation

```bash
bun init
bun add ocpipe
```

OpenCode CLI is bundled — run `bun run opencode` or use your system `opencode` if installed (preferred).

See [example/](./example) for a complete example.

### Documentation

- [Getting Started](./GETTING_STARTED.md) - Tutorial with examples
- [Design](./DESIGN.md) - Architecture and concepts
- [Contributing](./CONTRIBUTING.md) - Development setup

---

**Join the OpenCode community** [Discord](https://opencode.ai/discord) | follow on [X.com](https://x.com/opencode)

<div align="center">
  <h3>OpenCode Pipeline</h3>
  <p>SDK for LLM pipelines with <a href="https://opencode.ai">OpenCode</a> and <a href="https://zod.dev">Zod</a>.</p>
</div>

<div align="center">

```
Signature  →  Predict  →  Module  →  Pipeline
   │            │           │           │
 what        execute     compose    orchestrate
```

</div>

```typescript
import { signature, field, SignatureModule, Pipeline, createBaseState } from 'ocpipe'

// Define a signature
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

// Create a module
class Greeter extends SignatureModule<typeof Greet> {
  constructor() { super(Greet) }
  async forward(input: { name: string }, ctx) {
    return (await this.predictor.execute(input, ctx)).data
  }
}

// Run in a pipeline
const pipeline = new Pipeline({
  name: 'hello-world',
  defaultModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
  defaultAgent: 'code',
  checkpointDir: './ckpt',
  logDir: './logs',
}, createBaseState)

const result = await pipeline.run(new Greeter(), { name: 'World' })
console.log(result.data.greeting)  // "Hello, World! It's wonderful to meet you!"
```

## Install

```bash
bun add ocpipe zod
```

Requires [Bun](https://bun.sh) and [OpenCode](https://opencode.ai) CLI.

## Documentation

- [Getting Started](./GETTING_STARTED.md) - Tutorial with examples
- [Design](./DESIGN.md) - Architecture and concepts
- [Contributing](./CONTRIBUTING.md) - Development setup

## License

[MIT](./LICENSE)

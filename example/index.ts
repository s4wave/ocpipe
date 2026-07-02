/**
 * Hello World example runner.
 *
 * Demonstrates running an ocpipe module in a pipeline.
 *
 *   npx tsx example/index.ts               # Use OMP backend
 *   npx tsx example/index.ts --claude-code # Use Claude Code backend
 */

import { Pipeline, createBaseState } from '../src/index.js'
import { Greeter } from './module.js'

const useClaudeCode = process.argv.includes('--claude-code')

async function main() {
  // Create a pipeline with configuration
  const pipeline = new Pipeline(
    {
      name: 'hello-world',
      defaultModel:
        useClaudeCode ?
          { backend: 'claude-code', modelID: 'sonnet' }
        : { backend: 'omp', modelID: 'gpt-5.5' },
      checkpointDir: './ckpt',
      logDir: './logs',
    },
    createBaseState,
  )

  // Run the greeter module
  const result = await pipeline.run(new Greeter(), { name: 'World' })

  console.log('\n=== Result ===')
  console.log(`Greeting: ${result.data.greeting}`)
  console.log(`Emoji: ${result.data.emoji}`)
}

main().catch(console.error)

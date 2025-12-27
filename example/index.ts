/**
 * Hello World example runner.
 *
 * Demonstrates running an ocpipe module in a pipeline.
 */

import { Pipeline, createBaseState } from '../src/index.js'
import { Greeter } from './module.js'

async function main() {
  // Create a pipeline with configuration
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

  // Run the greeter module
  const result = await pipeline.run(new Greeter(), { name: 'World' })

  console.log('\n=== Result ===')
  console.log(`Greeting: ${result.data.greeting}`)
  console.log(`Emoji: ${result.data.emoji}`)
}

main().catch(console.error)

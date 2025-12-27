/**
 * Auto-correction example.
 *
 * Demonstrates DSTS's automatic schema correction using jq patches.
 * This example uses a schema with specific field names that LLMs
 * sometimes get wrong (e.g., "type" instead of "issue_type").
 */

import { z } from 'zod'
import { Pipeline, createBaseState, signature, field, SignatureModule } from '../index.js'
import type { ExecutionContext } from '../types.js'

// A signature with field names that LLMs often get wrong
const AnalyzeIssue = signature({
  doc: `Analyze the given code issue and categorize it.

IMPORTANT: Use the EXACT field names specified in the schema.`,
  inputs: {
    description: field.string('Description of the code issue'),
  },
  outputs: {
    // LLMs often return "type" instead of "issue_type"
    issue_type: field.enum(['bug', 'feature', 'refactor', 'docs'] as const, 'Category of the issue'),
    // LLMs often return "priority" instead of "severity"
    severity: field.enum(['low', 'medium', 'high', 'critical'] as const, 'How severe is the issue'),
    // LLMs often return "description" or "reason" instead of "explanation"
    explanation: field.string('Detailed explanation of the issue'),
    // LLMs often return just "tags" or "labels"
    suggested_tags: field.array(z.string(), 'Tags to apply to this issue'),
  },
})

class IssueAnalyzer extends SignatureModule<typeof AnalyzeIssue> {
  constructor() {
    super(AnalyzeIssue)
  }

  async forward(input: { description: string }, ctx: ExecutionContext) {
    const result = await this.predictor.execute(input, ctx)
    return result.data
  }
}

async function main() {
  const pipeline = new Pipeline(
    {
      name: 'correction-demo',
      defaultModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
      defaultAgent: 'code',
      checkpointDir: './ckpt',
      logDir: './logs',
    },
    createBaseState,
  )

  console.log('=== Auto-Correction Demo ===')
  console.log('This example uses field names that LLMs often get wrong.')
  console.log('Watch the correction rounds fix schema mismatches.\n')

  const result = await pipeline.run(new IssueAnalyzer(), {
    description: 'The login button does not respond when clicked on mobile devices',
  })

  console.log('\n=== Final Result ===')
  console.log(`Issue Type: ${result.data.issue_type}`)
  console.log(`Severity: ${result.data.severity}`)
  console.log(`Explanation: ${result.data.explanation}`)
  console.log(`Tags: ${result.data.suggested_tags.join(', ')}`)
}

main().catch(console.error)

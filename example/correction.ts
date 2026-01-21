/**
 * Auto-correction example.
 *
 * Demonstrates ocpipe's automatic schema correction.
 * This example uses a schema with specific field names that LLMs
 * sometimes get wrong (e.g., "type" instead of "issue_type").
 *
 * ocpipe supports two correction methods:
 * - 'json-patch' (default): RFC 6902 JSON Patch, no external dependencies
 * - 'jq': jq-style expressions, requires jq binary installed
 *
 * Usage:
 *   bun run example/correction.ts              # Uses default (json-patch)
 *   bun run example/correction.ts --jq         # Uses jq method
 */

import { z } from 'zod/v4'
import {
  Pipeline,
  createBaseState,
  signature,
  field,
  SignatureModule,
} from '../src/index.js'
import type { CorrectionMethod, ExecutionContext } from '../src/types.js'

// A signature with field names that LLMs often get wrong
const AnalyzeIssue = signature({
  doc: `Analyze the given code issue and categorize it.

IMPORTANT: Use the EXACT field names specified in the schema.`,
  inputs: {
    description: field.string('Description of the code issue'),
  },
  outputs: {
    // LLMs often return "type" instead of "issue_type"
    issue_type: field.enum(
      ['bug', 'feature', 'refactor', 'docs'] as const,
      'Category of the issue',
    ),
    // LLMs often return "priority" instead of "severity"
    severity: field.enum(
      ['low', 'medium', 'high', 'critical'] as const,
      'How severe is the issue',
    ),
    // LLMs often return "description" or "reason" instead of "explanation"
    explanation: field.string('Detailed explanation of the issue'),
    // LLMs often return just "tags" or "labels"
    suggested_tags: field.array(z.string(), 'Tags to apply to this issue'),
  },
})

class IssueAnalyzer extends SignatureModule<typeof AnalyzeIssue> {
  constructor(method: CorrectionMethod = 'json-patch') {
    super(AnalyzeIssue, {
      correction: { method },
    })
  }

  async forward(input: { description: string }, ctx: ExecutionContext) {
    const result = await this.predictor.execute(input, ctx)
    return result.data
  }
}

async function main() {
  // Check for --jq flag
  const method: CorrectionMethod =
    process.argv.includes('--jq') ? 'jq' : 'json-patch'

  const pipeline = new Pipeline(
    {
      name: 'correction-demo',
      defaultModel: { providerID: 'opencode', modelID: 'minimax-m2.1-free' },
      defaultAgent: 'default',
      checkpointDir: './ckpt',
      logDir: './logs',
    },
    createBaseState,
  )

  console.log('=== Auto-Correction Demo ===')
  console.log(`Correction method: ${method}`)
  console.log('This example uses field names that LLMs often get wrong.')
  console.log('Watch the correction rounds fix schema mismatches.\n')

  const result = await pipeline.run(new IssueAnalyzer(method), {
    description:
      'The login button does not respond when clicked on mobile devices',
  })

  console.log('\n=== Final Result ===')
  console.log(`Issue Type: ${result.data.issue_type}`)
  console.log(`Severity: ${result.data.severity}`)
  console.log(`Explanation: ${result.data.explanation}`)
  console.log(`Tags: ${result.data.suggested_tags.join(', ')}`)
}

main().catch(console.error)

/**
 * Hello World module.
 *
 * Wraps the Greet signature with execution logic.
 */

import { SignatureModule } from '../src/index.js'
import type { ExecutionContext } from '../src/types.js'
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

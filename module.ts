/**
 * DSTS SDK Module base class.
 *
 * Modules encapsulate logical units of work that use one or more Predictors.
 */

import type { ExecutionContext, SignatureDef } from './types.js'
import { Predict, type PredictConfig } from './predict.js'

/** Module is the abstract base class for composable workflow units. */
export abstract class Module<I, O> {
  private predictors: Predict<any>[] = []

  /** predict creates and registers a Predict instance for a signature. */
  protected predict<S extends SignatureDef<any, any>>(
    sig: S,
    config?: PredictConfig,
  ): Predict<S> {
    const p = new Predict(sig, config)
    this.predictors.push(p)
    return p
  }

  /** forward is the main execution method to be implemented by subclasses. */
  abstract forward(input: I, ctx: ExecutionContext): Promise<O>

  /** getPredictors returns all registered predictors (for future optimization). */
  getPredictors(): Predict<any>[] {
    return this.predictors
  }
}

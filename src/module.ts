/**
 * DSTS SDK Module base class.
 *
 * Modules encapsulate logical units of work that use one or more Predictors.
 */

import type {
  ExecutionContext,
  InferInputs,
  InferOutputs,
  SignatureDef,
} from './types.js'
export type { ExecutionContext } from './types.js'
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

/** SignatureModule is a Module whose types are derived from a Signature. */
export abstract class SignatureModule<
  S extends SignatureDef<any, any>,
> extends Module<InferInputs<S>, InferOutputs<S>> {
  protected readonly sig: S
  protected readonly predictor: Predict<S>

  constructor(sig: S, config?: PredictConfig) {
    super()
    this.sig = sig
    this.predictor = this.predict(sig, config)
  }
}

/** SimpleModule is a SignatureModule that just executes the predictor. */
class SimpleModule<
  S extends SignatureDef<any, any>,
> extends SignatureModule<S> {
  constructor(sig: S, config?: PredictConfig) {
    super(sig, config)
  }

  async forward(
    input: InferInputs<S>,
    ctx: ExecutionContext,
  ): Promise<InferOutputs<S>> {
    return (await this.predictor.execute(input, ctx)).data
  }
}

/** module creates a simple Module from a Signature (syntactic sugar). */
export function module<S extends SignatureDef<any, any>>(
  sig: S,
  config?: PredictConfig,
): Module<InferInputs<S>, InferOutputs<S>> {
  return new SimpleModule(sig, config)
}

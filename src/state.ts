/**
 * ocpipe state management.
 *
 * Provides base state types and helpers for checkpointable workflow state.
 */

import type { BaseState } from './types.js'

/** createSessionId generates a unique session ID based on the current timestamp. */
export function createSessionId(): string {
  const now = new Date()
  const id = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .split('.')[0]
  return id ?? ''
}

/** createBaseState creates a new base state with default values. */
export function createBaseState(): BaseState {
  return {
    sessionId: createSessionId(),
    startedAt: new Date().toISOString(),
    phase: 'init',
    steps: [],
    subPipelines: [],
  }
}

/** extendBaseState creates a state factory that extends BaseState with additional fields. */
export function extendBaseState<T extends Record<string, unknown>>(
  extension: T,
): BaseState & T {
  return {
    ...createBaseState(),
    ...extension,
  }
}

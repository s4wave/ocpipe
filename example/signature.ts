/**
 * Hello World signature.
 *
 * Defines the input/output contract for greeting generation.
 */

import { signature, field } from '../src/index.js'

export const Greet = signature({
  doc: 'Generate a friendly greeting for the given name.',
  inputs: {
    name: field.string('The name of the person to greet'),
  },
  outputs: {
    greeting: field.string('A friendly greeting message'),
    emoji: field.string('An appropriate emoji for the greeting'),
  },
})

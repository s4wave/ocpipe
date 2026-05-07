import { describe, expect, test } from 'vitest'

import { filterCodexLogText } from './codex.js'

describe('filterCodexLogText', () => {
  test('suppresses timestamped Codex warning lines', () => {
    const text =
      'before\n' +
      '2026-05-07T22:52:05.951455Z  WARN codex_core::config: ignored key\n' +
      'after\n'

    expect(filterCodexLogText(text)).toBe('before\nafter\n')
  })

  test('preserves unrelated warning output', () => {
    const text = '2026-05-07T22:52:05.951455Z  WARN unrelated warning\n'

    expect(filterCodexLogText(text)).toBe(text)
  })

  test('suppresses Cloudflare HTML challenge blocks from Codex startup', () => {
    const text =
      'before\n' +
      '  <head>\n' +
      '    <meta http-equiv="refresh" content="360">\n' +
      '  </head>\n' +
      '  <body>Enable JavaScript and cookies to continue</body>\n' +
      '</html>\n' +
      'after\n'

    expect(filterCodexLogText(text)).toBe('before\nafter\n')
  })
})

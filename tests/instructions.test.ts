import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildInstructions, type ServerMode } from '../src/instructions.js'
import { visibleToolNames, type ToolVisibility } from '../src/tools/index.js'

// ─── The server instructions, pinned ───────────────────────────────────────
//
// tests/fixtures/instructions.json holds the exact instructions text of every
// composition (stdio, hosted) in every situation, as 0.5.1 served it. The
// default build must keep producing it byte for byte.
//
// To regenerate after an INTENTIONAL text change:
//   INSTRUCTIONS_FIXTURE_WRITE=1 pnpm vitest run tests/instructions.test.ts
// The run rewrites the fixture and then fails on purpose; review the diff,
// then re-run the suite normally.

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'instructions.json')

const SITUATIONS: Array<[string, ToolVisibility | undefined]> = [
  ['full surface', undefined],
  ['unregistered', { registered: false, webhookTools: false }],
  ['registered, webhook tools', { registered: true, webhookTools: true }],
  ['registered, socket integration', { registered: true, webhookTools: false }],
]

const MODES: ServerMode[] = ['stdio', 'hosted']

function defaults(): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const mode of MODES) {
    for (const [label, visibility] of SITUATIONS) {
      texts[`${mode} / ${label}`] = buildInstructions(mode, visibleToolNames(visibility).length, visibility)
    }
  }
  return texts
}

describe('the default instructions', () => {
  it('are exactly the pinned texts', () => {
    const texts = defaults()
    if (process.env['INSTRUCTIONS_FIXTURE_WRITE'] === '1') {
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(texts, null, 2)}\n`)
      throw new Error(`fixture rewritten at ${FIXTURE_PATH}; review the diff, then re-run without INSTRUCTIONS_FIXTURE_WRITE`)
    }
    const pinned = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>
    expect(Object.keys(texts).sort()).toEqual(Object.keys(pinned).sort())
    for (const [key, text] of Object.entries(texts)) expect(text, key).toBe(pinned[key])
  })
})

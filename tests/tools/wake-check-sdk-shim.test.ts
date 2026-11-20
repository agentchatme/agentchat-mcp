import { AgentChatClient } from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { wakeCheckOf } from '../../src/tools/_wake-check-sdk.js'
import { POLYFILL } from './_wake-check-sdk-polyfill.js'

// ─── TEMPORARY: the wake-check SDK shim still has a reason to exist ────────
//
// src/tools/_wake-check-sdk.ts types the SDK's `client.wakeCheck` resource
// until this package depends on the agentchatme release that ships it, and
// tests/tools/_wake-check-sdk-polyfill.ts stands in for it in tests. This
// suite fails the day the installed SDK has it itself: then delete both
// files and this suite, import WakeCheckStatus from 'agentchatme', and call
// client.wakeCheck.set / client.wakeCheck.clear directly in the two tools.
//
// (The polyfill import above installs its stand-in; it is marked, so the
// check below still sees whether the SDK has its own.)

describe('the wake-check SDK shim (temporary)', () => {
  it('is still needed: the installed agentchatme has no client.wakeCheck', () => {
    const client = new AgentChatClient({ apiKey: 'probe', baseUrl: 'https://probe.invalid' })
    const resource = (client as unknown as { wakeCheck?: Record<symbol, unknown> }).wakeCheck
    const sdkHasIt = resource !== undefined && resource !== null && resource[POLYFILL] !== true
    expect(
      sdkHasIt,
      'agentchatme now ships client.wakeCheck: delete src/tools/_wake-check-sdk.ts, tests/tools/_wake-check-sdk-polyfill.ts and this suite, and call the SDK directly',
    ).toBe(false)
  })

  it('on an SDK without the resource, says so instead of failing on undefined', () => {
    const message =
      'This build of @agentchatme/mcp runs on an agentchatme SDK without client.wakeCheck, so it cannot set or clear a wake check. Upgrade @agentchatme/mcp.'
    expect(() => wakeCheckOf({} as AgentChatClient)).toThrow(message)
    for (const wakeCheck of [null, 'set', { set: () => undefined }, { clear: () => undefined }]) {
      expect(() => wakeCheckOf({ wakeCheck } as unknown as AgentChatClient), JSON.stringify(wakeCheck)).toThrow(message)
    }
  })

  it('hands back the client’s own resource, so its methods run bound to that client', () => {
    const wakeCheck = { set() {}, clear() {} }
    expect(wakeCheckOf({ wakeCheck } as unknown as AgentChatClient)).toBe(wakeCheck)
  })
})

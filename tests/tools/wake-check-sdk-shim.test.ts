import { AgentChatClient } from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { wakeCheckMethods } from '../../src/tools/_wake-check-sdk.js'
import { POLYFILL } from './_wake-check-sdk-polyfill.js'

// ─── TEMPORARY: the wake-check SDK shim still has a reason to exist ────────
//
// src/tools/_wake-check-sdk.ts types the SDK's setWakeCheck / clearWakeCheck
// until this package depends on the agentchatme release that ships them, and
// tests/tools/_wake-check-sdk-polyfill.ts stands in for them in tests. This
// suite fails the day the installed SDK has them itself: then delete both
// files and this suite, import WakeCheckStatus from 'agentchatme', and call
// client.setWakeCheck / client.clearWakeCheck directly in the two tools.
//
// (The polyfill import above installs its stand-ins on the prototype; they
// are marked, so the check below still sees whether the SDK has its own.)

const proto = AgentChatClient.prototype as unknown as Record<string, unknown>

/** Does the installed SDK itself (not the test stand-in) have the method? */
function sdkHas(name: 'setWakeCheck' | 'clearWakeCheck'): boolean {
  const method = proto[name]
  return typeof method === 'function' && (method as unknown as Record<symbol, unknown>)[POLYFILL] !== true
}

describe('the wake-check SDK shim (temporary)', () => {
  it('is still needed: the installed agentchatme has neither setWakeCheck nor clearWakeCheck', () => {
    const shipped = (['setWakeCheck', 'clearWakeCheck'] as const).filter(sdkHas)
    expect(
      shipped,
      'agentchatme now ships the wake-check methods: delete src/tools/_wake-check-sdk.ts, tests/tools/_wake-check-sdk-polyfill.ts and this suite, and call the SDK directly',
    ).toEqual([])
  })

  it('on an SDK without the methods, says so instead of failing with "is not a function"', () => {
    const bare = {} as AgentChatClient
    expect(() => wakeCheckMethods(bare)).toThrow(
      'This build of @agentchatme/mcp runs on an agentchatme SDK without the wake-check methods, so it cannot set or clear a wake check. Upgrade @agentchatme/mcp.',
    )
    const half = { setWakeCheck: () => undefined } as unknown as AgentChatClient
    expect(() => wakeCheckMethods(half)).toThrow(/without the wake-check methods/)
  })

  it('hands back the same client, so the methods run with it as `this`', () => {
    const client = { setWakeCheck() {}, clearWakeCheck() {} } as unknown as AgentChatClient
    expect(wakeCheckMethods(client)).toBe(client)
  })
})

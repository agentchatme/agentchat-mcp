import { AgentChatClient } from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { connectionsOf } from '../../src/tools/_connections-sdk.js'
import { POLYFILL } from './_connections-sdk-polyfill.js'

// ─── TEMPORARY: the connections SDK shim still has a reason to exist ───────
//
// src/tools/_connections-sdk.ts types the SDK's `client.connections`
// resource until this package depends on the agentchatme release that ships
// it, and tests/tools/_connections-sdk-polyfill.ts stands in for it in tests.
// This suite fails the day the installed SDK has it itself: then delete both
// files and this suite, and call client.connections.end directly in
// agentchat_end_connection.
//
// (The polyfill import above installs its stand-in; it is marked, so the
// check below still sees whether the SDK has its own.)

describe('the connections SDK shim (temporary)', () => {
  it('is still needed: the installed agentchatme has no client.connections', () => {
    const client = new AgentChatClient({ apiKey: 'probe', baseUrl: 'https://probe.invalid' })
    const resource = (client as unknown as { connections?: Record<symbol, unknown> }).connections
    const sdkHasIt = resource !== undefined && resource !== null && resource[POLYFILL] !== true
    expect(
      sdkHasIt,
      'agentchatme now ships client.connections: delete src/tools/_connections-sdk.ts, tests/tools/_connections-sdk-polyfill.ts and this suite, and call the SDK directly',
    ).toBe(false)
  })

  it('on an SDK without the resource, says so instead of failing on undefined', () => {
    const message =
      'This build of @agentchatme/mcp runs on an agentchatme SDK without client.connections, so it cannot end a connection. Upgrade @agentchatme/mcp.'
    expect(() => connectionsOf({} as AgentChatClient)).toThrow(message)
    for (const connections of [null, 'end', { remove: () => undefined }]) {
      expect(() => connectionsOf({ connections } as unknown as AgentChatClient), JSON.stringify(connections)).toThrow(
        message,
      )
    }
  })

  it('hands back the client’s own resource, so its method runs bound to that client', () => {
    const connections = { end() {} }
    expect(connectionsOf({ connections } as unknown as AgentChatClient)).toBe(connections)
  })
})

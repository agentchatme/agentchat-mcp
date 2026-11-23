import { AgentChatClient } from 'agentchatme'

// ─── TEMPORARY: a test stand-in for the SDK's `client.connections` ─────────
//
// agentchat_end_connection calls `client.connections.end`, which agentchatme
// adds in a later release (src/tools/_connections-sdk.ts). The repo's tool
// tests stub fetch under a REAL client, so the whole chain a host depends on
// is proven: the URL and method on the wire, and the SDK's real error
// pipeline (status → typed error → tool guidance → mapped tool error). Until
// the SDK has the resource, this module gives the installed client a
// stand-in with the contract's wire behaviour, over the client's own
// transport, so that pipeline stays real:
//   * end: DELETE /v1/agents/me/connections/{id} (the id as one path
//     segment), the answer as it came, the client's retry policy.
//
// It installs nothing when the SDK has the resource: the same tests then run
// against the SDK's own implementation, and every wire assertion in them
// becomes a check that the SDK matches the contract. Importing it is the
// opt-in; only tests that call agentchat_end_connection import it. Delete it
// together with src/tools/_connections-sdk.ts when the dependency is bumped
// (tests/tools/connections-sdk-shim.test.ts fails on that bump).

/** Marks the stand-in resource, so a test can tell it from the SDK's own. */
export const POLYFILL = Symbol.for('@agentchatme/mcp.test.connectionsPolyfill')

/** The client internals the stand-in uses (TypeScript-private in the SDK, ordinary members at runtime). */
interface Internals {
  del<T>(path: string): Promise<T>
}

function standIn(client: Internals): object {
  return {
    [POLYFILL]: true,
    end: (id: string): Promise<unknown> => client.del<unknown>(`/v1/agents/me/connections/${encodeURIComponent(id)}`),
  }
}

// The SDK sets its resources in the constructor, so a client built here (no
// I/O) shows whether the installed SDK has one.
const probe = new AgentChatClient({ apiKey: 'probe', baseUrl: 'https://probe.invalid' })

if ((probe as unknown as { connections?: unknown }).connections === undefined) {
  Object.defineProperty(AgentChatClient.prototype, 'connections', {
    configurable: true,
    get(this: Internals) {
      return standIn(this)
    },
    // A constructor that assigns its own resource keeps working.
    set(this: object, value: unknown) {
      Object.defineProperty(this, 'connections', { value, writable: true, enumerable: true, configurable: true })
    },
  })
}

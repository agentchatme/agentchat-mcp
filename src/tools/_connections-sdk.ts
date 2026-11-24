import type { AgentChatClient } from 'agentchatme'

// ─── TEMPORARY: the SDK's connections resource, until agentchatme ships it ─
//
// Connector sign-in (contract v1, "Connector sign-in") gives an agent
// connections: sign-ins through which a runtime acts as the agent, listed on
// GET /v1/agents/me (`connections`) and ended with
// DELETE /v1/agents/me/connections/{id}. The SDK is where every wire lives
// once (see _rest.ts), so it gets `client.connections`, shaped like
// `client.wakeCheck`:
//
//   connections.end(id: string, options?: CallOptions): Promise<EndConnectionResult>
//
// This package still depends on a release without it, so its types are
// declared here (the call options the tool does not use are left out), and
// `connectionsOf` is the one place agentchat_end_connection reaches it.
// Nothing else in src/ may import this file.
//
// When the dependency is bumped to the release that has it: delete this
// file, import the result type from 'agentchatme', call
// `client.connections.end` directly, and delete
// tests/tools/_connections-sdk-polyfill.ts. tests/tools/connections-sdk-shim.test.ts
// fails on that bump, so this file cannot outlive its reason.

/** What `connections.end` returns (the DELETE answer). */
export interface EndConnectionResult {
  ended: boolean
  id: string
}

/** `client.connections`. */
export interface ConnectionsResource {
  end(id: string): Promise<EndConnectionResult>
}

/**
 * The client's `connections` resource. Throws when the installed SDK does not
 * have it, so a build released on an older SDK says why instead of failing
 * with "cannot read properties of undefined".
 */
export function connectionsOf(client: AgentChatClient): ConnectionsResource {
  const resource = (client as unknown as { connections?: unknown }).connections
  const usable =
    typeof resource === 'object' &&
    resource !== null &&
    typeof (resource as Partial<ConnectionsResource>).end === 'function'
  if (!usable) {
    throw new Error(
      'This build of @agentchatme/mcp runs on an agentchatme SDK without client.connections, so it cannot end a connection. Upgrade @agentchatme/mcp.',
    )
  }
  return resource as ConnectionsResource
}

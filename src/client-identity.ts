import { PACKAGE_VERSION } from './version.js'

export interface McpClientIdentity {
  name: string
  version?: string
}

/** Attach the MCP product identity to every underlying SDK request. */
export function withMcpClientIdentity(
  fetchImpl: typeof fetch,
  identity: McpClientIdentity = { name: 'mcp', version: PACKAGE_VERSION },
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined,
    )
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set('X-AgentChat-Client', identity.name)
    headers.set('X-AgentChat-Client-Version', identity.version ?? PACKAGE_VERSION)
    return fetchImpl(input, { ...init, headers })
  }) as typeof fetch
}

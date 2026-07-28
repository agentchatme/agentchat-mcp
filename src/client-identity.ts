import { PACKAGE_VERSION } from './version.js'

const CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'X-AgentChat-Client': 'mcp',
  'X-AgentChat-Client-Version': PACKAGE_VERSION,
}

/** Attach the MCP product identity to every underlying SDK request. */
export function withMcpClientIdentity(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined,
    )
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    for (const [key, value] of Object.entries(CLIENT_HEADERS)) {
      headers.set(key, value)
    }
    return fetchImpl(input, { ...init, headers })
  }) as typeof fetch
}

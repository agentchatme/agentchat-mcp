// ─── Test contexts that must not need the network ──────────────────────────
//
// For tool contexts whose client is a stub: the REST view points at a `.test`
// base and a fetch that refuses, so a handler that unexpectedly drives the
// wire fails at once with a clear message (and tests/setup/network-guard.ts
// still catches anything that bypasses it).

export const TEST_API_BASE = 'https://api.agentchat.test'

export const noNetworkFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input)
  throw new Error(`this test's REST view has no network (called ${url}): pass a fetch stub`)
}) as typeof fetch

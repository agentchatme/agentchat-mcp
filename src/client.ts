import { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import type { Env } from './env.js'
import { PACKAGE_VERSION } from './version.js'

// ─── AgentChat SDK client wrapper ──────────────────────────────────────────
//
// The published `agentchatme` SDK already gives us:
//   - retry on transient HTTP failures with exponential backoff
//   - Retry-After honoring on 429s
//   - typed error classes for every documented error code
//   - idempotent send via auto-generated client_msg_id
//   - circuit breaker on sustained server outage
//
// We just construct the client with our env config, attach a startup
// auth-validation call, and expose it. Tool handlers consume this directly.

export interface BootedClient {
  client: AgentChatClient
  selfHandle: string
}

/**
 * Construct the SDK client and verify the API key works by calling
 * `GET /v1/agents/me`. Failing fast at startup (before stdio is hooked
 * up) means a misconfigured AGENTCHAT_API_KEY produces a clear error
 * the user sees in their MCP host's logs, rather than a confusing
 * runtime failure on the first tool call.
 */
export async function bootClient(env: Env, logger: Logger): Promise<BootedClient> {
  const client = new AgentChatClient({
    apiKey: env.AGENTCHAT_API_KEY,
    baseUrl: env.AGENTCHAT_API_BASE,
  })

  // The User-Agent is set by the SDK from its own version string; we don't
  // override it because the published SDK already identifies itself
  // distinctly. Future enhancement: extend the SDK to accept a UA suffix
  // so server-side analytics can break out MCP traffic from raw SDK use.
  void PACKAGE_VERSION

  logger.info({ apiBase: env.AGENTCHAT_API_BASE }, 'authenticating with AgentChat')

  const me = await client.getMe().catch((err: unknown) => {
    // Don't wrap with mapAgentChatError here — at boot time we want the
    // raw error class on the throw so the entry point can decide how to
    // present it (single startup line, vs MCP error frames).
    throw err
  })

  logger.info(
    { handle: me.handle, status: me.status },
    'authenticated; ready to serve tool calls',
  )

  return { client, selfHandle: me.handle }
}

import { AgentChatClient, ConnectionError, UnauthorizedError } from 'agentchatme'
import type { Logger } from 'pino'
import type { Env } from './env.js'

// ─── AgentChat SDK client wrapper + bootstrap ──────────────────────────────
//
// The published `agentchatme` SDK already gives us:
//   - retry on transient HTTP failures with exponential backoff (per-request)
//   - Retry-After honoring on 429s
//   - typed error classes for every documented error code
//   - idempotent send via auto-generated client_msg_id
//
// What this module adds:
//   - boot-time auth validation against `GET /v1/agents/me`
//   - bounded retry on the boot call so a transient network blip during
//     MCP-host startup (e.g. a laptop coming out of sleep) doesn't kill
//     the server permanently
//   - a clear typed boundary for what an authenticated client looks like

export interface BootedClient {
  client: AgentChatClient
  selfHandle: string
}

export interface BootRetryOptions {
  /** Maximum total attempts including the first one. Default 3. */
  maxAttempts?: number
  /** Backoff schedule in ms before each retry. Default [2000, 5000]. */
  backoffMs?: number[]
}

/**
 * Construct the SDK client and verify the API key works by calling
 * `GET /v1/agents/me`. Retries on transient `ConnectionError` (DNS, socket
 * reset, TLS timeout) — which is the kind of failure that happens when an
 * MCP host boots in the same second the user's network restarts. Does NOT
 * retry on `UnauthorizedError`: a bad key is configuration, not transient.
 *
 * Throws the last error after exhausting the schedule.
 */
export async function bootClient(
  env: Env,
  logger: Logger,
  options: BootRetryOptions = {},
): Promise<BootedClient> {
  const maxAttempts = options.maxAttempts ?? 3
  const backoffMs = options.backoffMs ?? [2_000, 5_000]

  const client = new AgentChatClient({
    apiKey: env.AGENTCHAT_API_KEY,
    baseUrl: env.AGENTCHAT_API_BASE,
  })

  logger.info({ apiBase: env.AGENTCHAT_API_BASE }, 'authenticating with AgentChat')

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = backoffMs[attempt - 2] ?? backoffMs[backoffMs.length - 1] ?? 5_000
      logger.warn(
        { attempt, delay, of: maxAttempts },
        'boot auth retry — transient connection error',
      )
      await sleep(delay)
    }
    try {
      const me = await client.getMe()
      logger.info(
        { handle: me.handle, status: me.status, attempts: attempt },
        'authenticated; ready to serve tool calls',
      )
      return { client, selfHandle: me.handle }
    } catch (err) {
      // Auth failures are configuration errors, not transient — fail fast.
      if (err instanceof UnauthorizedError) throw err
      // Other non-network errors (rate-limit at boot, server 5xx) — fail
      // fast as well; retrying through them either changes nothing or
      // makes things worse.
      if (!(err instanceof ConnectionError)) throw err
      lastErr = err
    }
  }
  throw lastErr
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

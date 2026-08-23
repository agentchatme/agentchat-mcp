import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import type { Semaphore } from '../semaphore.js'

// ─── Tool registration contract ────────────────────────────────────────────
//
// Each tool file exports `NAME`, `INPUT_SHAPE`, `createHandler`, and
// `register`. Splitting the handler factory from the registration is
// deliberate: tests construct handlers directly with a stubbed client and
// assert call shape, without needing to plug in the MCP transport.
//
// `inflight` is the shared Set of running tool-call promises. Tools push
// their work onto it via `withErrorBoundary`; shutdown awaits the set
// before exiting so SIGTERM never aborts a mid-flight API call. The set
// is mutable and lives across tool invocations — the boundary wrapper
// owns the add/remove discipline.

/**
 * Raw REST view of the session identity, for the few tools that talk to
 * endpoints the SDK client does not cover (registration, which must work
 * with NO identity at all, and the wake-webhook endpoints).
 *
 * Both compositions expose this as a live getter, so on stdio it re-resolves
 * the credentials file exactly like `client` does; the hosted composition
 * returns the fixed per-session values.
 */
export interface RestContext {
  /** Effective API base URL for this session (no trailing slash required). */
  apiBase: string
  /** The current API key, or null when the session has no identity yet. */
  apiKey: string | null
  /**
   * The fetch implementation direct REST calls must go through. Carries the
   * same product-identity headers as the SDK client (and, hosted, the
   * gateway's User-Agent). Tests stub the network here.
   */
  fetchImpl: typeof fetch
}

export interface ToolContext {
  client: AgentChatClient
  logger: Logger
  selfHandle: string
  semaphore: Semaphore
  inflight: Set<Promise<unknown>>
  /** Raw identity view for tools that bypass the SDK client. Live getter. */
  rest: RestContext
  /**
   * Turn-scoped idempotency key for autonomous host turns, or undefined for
   * interactive sessions. The stdio composition reads
   * AGENTCHAT_TURN_IDEMPOTENCY_KEY at call time (preserving the historical
   * env contract); the hosted composition always returns undefined so a
   * multi-tenant process can never inherit an ambient turn key.
   */
  turnKey: () => string | undefined
}

export type ToolRegistration = (server: McpServer, ctx: ToolContext) => void

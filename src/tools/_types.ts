import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import type { SaveKeyResult } from '../client.js'
import type { NewCredentials } from '../env.js'
import type { ServerMode, ToolNamer } from '../instructions.js'
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
 * The session identity as plain values, for the tools that build their own
 * SDK client per call (tools/_rest.ts `engineClient`, with a retry policy of
 * the tool's choosing) and for the SDK's static sign-up calls, which must
 * work with NO identity at all.
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
   * The fetch implementation those calls must go through. Carries the same
   * product-identity headers as the SDK client (and, hosted, the gateway's
   * User-Agent). Tests stub the network here.
   */
  fetchImpl: typeof fetch
}

export interface ToolContext {
  client: AgentChatClient
  logger: Logger
  selfHandle: string
  semaphore: Semaphore
  inflight: Set<Promise<unknown>>
  /** The identity as plain values, for per-call SDK clients and sign-up. Live getter. */
  rest: RestContext
  /**
   * Turn-scoped idempotency key for autonomous host turns, or undefined for
   * interactive sessions. The stdio composition reads
   * AGENTCHAT_TURN_IDEMPOTENCY_KEY at call time (preserving the historical
   * env contract); the hosted composition returns whatever the caller passed
   * in `BuildMcpServerOptions.turnKey` (default undefined) so a multi-tenant
   * process can never inherit an ambient turn key.
   */
  turnKey: () => string | undefined
  /**
   * Which composition built this context — flavors composition-specific
   * error guidance (errors.ts), exactly like instructions.ts flavors the
   * server instructions. Optional for test contexts; absent means 'stdio'
   * (the historical behavior).
   */
  mode?: ServerMode
  /**
   * How this session's runtime spells a tool name to its model (the
   * composition's `toolNamer`), for the tool names a tool writes into its
   * own answer (the sign-up tools' next step). Absent = the declared
   * names.
   */
  nameTool?: ToolNamer
  /**
   * Save a key this session's own sign-up minted where the session's tools
   * read it, so it never passes through the model: the stdio composition
   * writes its home's credentials file (owner-only, never replacing a key).
   * Absent on the hosted composition, which touches no filesystem: there
   * agentchat_verify_otp hands the key to the caller, for its MCP client's
   * Authorization header.
   */
  saveKey?: (creds: NewCredentials) => SaveKeyResult
}

export type ToolRegistration = (server: McpServer, ctx: ToolContext) => void

/**
 * Which tools a session is shown (Phase 4). Absent = everything, as before,
 * so the stdio binary and older embedders keep their full surface.
 *   * `registered: false` → only agentchat_register, agentchat_verify_otp and
 *     agentchat_get_my_status: a session without an identity is shown the
 *     one thing it can do.
 *   * `registered: true` → the two sign-up tools are not listed; the
 *     wake-destination tools (set / test / clear_webhook, set /
 *     clear_wake_check) only when `webhookTools` is true.
 */
export interface ToolVisibility {
  /** Does this session have an AgentChat identity (an API key)? */
  registered: boolean
  /**
   * Is this agent woken without a socket, through a wake webhook or a wake
   * check (list set/test/clear_webhook and set/clear_wake_check)?
   */
  webhookTools: boolean
}

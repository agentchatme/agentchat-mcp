import { isIP } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Logger } from 'pino'
import { defaultMcpFetch, FixedIdentityProvider } from './client.js'
import { buildInstructions } from './instructions.js'
import { createLogger } from './log.js'
import { Semaphore } from './semaphore.js'
import type { ToolContext } from './tools/_types.js'
import { registerAllTools, TOOL_COUNT } from './tools/index.js'
import { PACKAGE_VERSION } from './version.js'

// ─── Hosted core: buildMcpServer ───────────────────────────────────────────
//
// The transport-agnostic composition of the AgentChat tool core. The stdio
// entry (src/index.ts → src/server.ts) keeps its own composition with the
// lazy on-disk identity; THIS one binds a fixed identity per built server so
// a hosted endpoint can construct one per authenticated HTTP session:
//
//   const server = buildMcpServer({
//     apiBase: 'https://api.agentchat.me',
//     apiKey: bearerKeyOrNull,
//     userAgent: 'agentchat-hosted-mcp/1.0',
//   })
//   await server.connect(transport)   // e.g. StreamableHTTPServerTransport
//
// Guarantees:
//   * Registers ALL tools, bound to exactly the identity in `opts`.
//   * Reads NOTHING ambient — no process.env, no credentials file. What you
//     pass is the entire identity. (The turn-idempotency env contract of the
//     stdio entry is explicitly severed here: `turnKey` resolves to whatever
//     the caller passed in `opts.turnKey` — default undefined — never to an
//     ambient env var, so a multi-tenant process can never leak one session's
//     turn key into another's sends.)
//   * `apiKey: null` builds an UNAUTHENTICATED session: every tool is still
//     listed, and calls fail with the structured NOT_AUTHENTICATED error —
//     except agentchat_register / agentchat_verify_otp, which work without a
//     key so a brand-new agent can mint its identity in-band.

export interface BuildMcpServerOptions {
  /** AgentChat API base URL, e.g. `https://api.agentchat.me`. */
  apiBase: string
  /**
   * The session's API key, or null for an unauthenticated session. An empty
   * or whitespace-only string is treated as null (a gateway forwarding a
   * missing Authorization header often produces exactly that).
   */
  apiKey: string | null
  /**
   * Optional User-Agent header attached to every AgentChat API request this
   * server makes — lets the hosting gateway identify itself upstream. The
   * X-AgentChat-Client product identity (`mcp/<package version>`) is always
   * attached regardless.
   */
  userAgent?: string
  /**
   * Optional known handle for this session's identity (with or without the
   * leading `@`). A hosted gateway that already authenticated the key knows
   * the handle; passing it here makes `ctx.selfHandle` correct IMMEDIATELY
   * and suppresses the lazy background `getMe()` lookup entirely. Without
   * it, per-request server instances would answer their first (often only)
   * tool call with the `'?'` placeholder — and own-vs-peer message
   * classification in agentchat_get_conversation would misclassify the
   * agent's own messages.
   */
  selfHandle?: string
  /**
   * Optional turn-idempotency key source, read at tool-call time — the
   * hosted twin of the stdio entry's AGENTCHAT_TURN_IDEMPOTENCY_KEY env
   * contract. A gateway hosting an always-on turn passes the session's turn
   * key here so retried sends stay idempotent. Default: always undefined
   * (interactive semantics); the core still never reads the environment.
   */
  turnKey?: () => string | undefined
  /**
   * Optional end-client IP for this session (IPv4 or IPv6, no port). When
   * set, every AgentChat API request this server makes carries it in
   * `X-Forwarded-For` (appended to any existing list, per standard
   * semantics). A hosted gateway calls the REST API over loopback, so
   * WITHOUT this every hosted session shares one IP bucket at the REST
   * layer's per-IP rate limits — the unauthenticated registration cap
   * (~12/hour/IP) would collapse across all tenants. The stdio entry never
   * sets it.
   */
  clientIp?: string
  /**
   * Optional structured logger (pino). Defaults to a silent logger — a
   * library must not spray logs it wasn't asked for. Pass your own to see
   * tool invocations/failures; keep it on stderr if the process also speaks
   * a stdio protocol.
   */
  logger?: Logger
  /**
   * Concurrent tool-call ceiling for THIS server instance (1-100, default
   * 10) — same backpressure semantics as the stdio entry's
   * AGENTCHAT_MAX_CONCURRENT_TOOLS.
   */
  maxConcurrentTools?: number
}

function normalizeApiBase(apiBase: string): string {
  let parsed: URL
  try {
    parsed = new URL(apiBase)
  } catch {
    throw new Error(
      `buildMcpServer: apiBase must be an absolute http(s) URL, got ${JSON.stringify(apiBase)}`,
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `buildMcpServer: apiBase must use http(s), got ${parsed.protocol}//`,
    )
  }
  return apiBase.replace(/\/+$/, '')
}

function withUserAgent(fetchImpl: typeof fetch, userAgent: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined,
    )
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set('User-Agent', userAgent)
    return fetchImpl(input, { ...init, headers })
  }) as typeof fetch
}

function withForwardedFor(fetchImpl: typeof fetch, clientIp: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined,
    )
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    // Standard XFF semantics: append to an existing chain, else start one.
    // Nothing upstream of this wrapper sets XFF today, but stay correct if
    // that ever changes.
    const existing = headers.get('x-forwarded-for')
    headers.set('x-forwarded-for', existing ? `${existing}, ${clientIp}` : clientIp)
    return fetchImpl(input, { ...init, headers })
  }) as typeof fetch
}

/**
 * Build an MCP server exposing the full AgentChat tool set, bound to exactly
 * the identity given in `opts`. The caller owns the transport: connect the
 * returned server to stdio, Streamable HTTP, in-memory for tests, etc.
 */
export function buildMcpServer(opts: BuildMcpServerOptions): McpServer {
  const apiBase = normalizeApiBase(opts.apiBase)

  const apiKey =
    typeof opts.apiKey === 'string' && opts.apiKey.trim().length > 0
      ? opts.apiKey.trim()
      : null

  if (opts.userAgent !== undefined) {
    // Header values are ByteStrings: every char must fit in one byte. A char
    // above U+00FF (e.g. '\u2192') passes a control-char-only check at build
    // time and then makes Headers.set throw at REQUEST time, surfacing as a
    // bogus CONNECTION_ERROR on every call. Reject control chars AND any
    // char outside Latin-1 here, at build time.
    // eslint-disable-next-line no-control-regex
    if (
      opts.userAgent.length === 0 ||
      /[\u0000-\u001f\u007f]/.test(opts.userAgent) ||
      /[^\u0000-\u00ff]/.test(opts.userAgent)
    ) {
      throw new Error(
        'buildMcpServer: userAgent must be a non-empty header-safe string (single-byte Latin-1 only; no control characters)',
      )
    }
  }

  if (opts.selfHandle !== undefined) {
    if (!/^@?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(opts.selfHandle)) {
      throw new Error(
        `buildMcpServer: selfHandle must be a valid AgentChat handle (lowercase letters, digits, single hyphens, optional leading @), got ${JSON.stringify(opts.selfHandle)}`,
      )
    }
  }

  if (opts.clientIp !== undefined && isIP(opts.clientIp) === 0) {
    throw new Error(
      `buildMcpServer: clientIp must be a bare IPv4/IPv6 address, got ${JSON.stringify(opts.clientIp)}`,
    )
  }

  const maxConcurrentTools = opts.maxConcurrentTools ?? 10
  if (
    !Number.isInteger(maxConcurrentTools) ||
    maxConcurrentTools < 1 ||
    maxConcurrentTools > 100
  ) {
    throw new Error(
      `buildMcpServer: maxConcurrentTools must be an integer between 1 and 100, got ${String(opts.maxConcurrentTools)}`,
    )
  }

  const logger = opts.logger ?? createLogger({ level: 'silent' })

  // One wrapped fetch feeds BOTH the SDK client and the direct REST
  // transports (register/verify/webhook), so every upstream call carries the
  // same product identity, User-Agent, and forwarded client IP.
  let baseFetch = globalThis.fetch
  if (opts.userAgent !== undefined) {
    baseFetch = withUserAgent(baseFetch, opts.userAgent)
  }
  if (opts.clientIp !== undefined) {
    baseFetch = withForwardedFor(baseFetch, opts.clientIp)
  }
  const fetchImpl = defaultMcpFetch(baseFetch)

  const provider = new FixedIdentityProvider({
    apiBase,
    apiKey,
    fetchImpl,
    ...(opts.selfHandle !== undefined ? { selfHandle: opts.selfHandle } : {}),
  })

  const server = new McpServer(
    {
      name: 'agentchat',
      version: PACKAGE_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions('hosted', TOOL_COUNT),
    },
  )

  const semaphore = new Semaphore(maxConcurrentTools)
  const inflight = new Set<Promise<unknown>>()

  const ctx: ToolContext = {
    get client() {
      return provider.getClientOrThrow()
    },
    get selfHandle() {
      return provider.getSelfHandle()
    },
    get rest() {
      return provider.getRest()
    },
    // Hosted sessions NEVER inherit an ambient turn key — see module header.
    // A gateway hosting an always-on turn passes its own source explicitly.
    turnKey: opts.turnKey ?? (() => undefined),
    mode: 'hosted',
    logger,
    semaphore,
    inflight,
  }
  registerAllTools(server, ctx)

  logger.debug(
    { tools: TOOL_COUNT, authenticated: apiKey !== null, maxConcurrentTools },
    'agentchat mcp core built',
  )

  return server
}

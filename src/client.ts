import { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import { resolveIdentity, type Config } from './env.js'
import { withMcpClientIdentity } from './client-identity.js'
import type { RestContext } from './tools/_types.js'
import { PACKAGE_VERSION } from './version.js'

type IdentityConfig = Pick<
  Config,
  'AGENTCHAT_API_BASE' | 'AGENTCHAT_MAX_CONCURRENT_TOOLS' | 'AGENTCHAT_LOG_LEVEL'
> &
  Partial<Pick<Config, 'AGENTCHAT_CLIENT_NAME' | 'AGENTCHAT_CLIENT_VERSION'>>

// ─── Lazy identity provider ─────────────────────────────────────────────────
//
// Tools no longer capture a client fixed at boot. They read `ctx.client` at
// call time; that getter comes here, and here we resolve the identity FRESHLY
// each call. Result: a mid-session `agentchat register` / `login` / `recover`
// is picked up on the very next tool call — no restart, no reconnect.
//
// Cost is negligible: resolving is a cheap credentials-file read, and the SDK
// client is rebuilt ONLY when the key actually changes (rare — a sign-in).
// Client construction is synchronous (no network), so this stays inside the
// synchronous getter the tools use. selfHandle comes straight from the
// credentials file (the CLI writes it); a bare AGENTCHAT_API_KEY deploy has no
// handle on disk, so we fetch it once in the background.

/** Thrown when a tool runs before any identity exists. Mapped to a friendly
 *  "register first" message in errors.ts — never crashes the server. */
export class NotRegisteredError extends Error {
  constructor() {
    super('no AgentChat identity configured')
    this.name = 'NotRegisteredError'
  }
}

/** Thrown when a HOSTED session runs a tool without an API key. Distinct from
 *  NotRegisteredError because the fix is different: the caller must send an
 *  Authorization header (or register in-band via agentchat_register), not run
 *  a local CLI. Mapped to NOT_AUTHENTICATED in errors.ts. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('no API key on this session')
    this.name = 'NotAuthenticatedError'
  }
}

/** The identity surface both compositions expose to the tool context. */
export interface IdentitySource {
  getClientOrThrow(): AgentChatClient
  getSelfHandle(): string
  getRest(): RestContext
}

export class IdentityProvider implements IdentitySource {
  private identitySignature: string | null = null
  private client: AgentChatClient | null = null
  private handle = '?'
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly config: IdentityConfig,
    private readonly logger: Logger,
  ) {
    this.fetchImpl = withMcpClientIdentity(globalThis.fetch, {
      name: this.config.AGENTCHAT_CLIENT_NAME ?? 'mcp',
      version: this.config.AGENTCHAT_CLIENT_VERSION,
    })
  }

  /** For a friendly boot log — is an identity resolvable right now? */
  hasIdentity(): boolean {
    return resolveIdentity() !== null
  }

  private refresh(): void {
    const id = resolveIdentity()
    if (!id) {
      this.identitySignature = null
      this.client = null
      this.handle = '?'
      return
    }
    const apiBase = id.apiBase ?? this.config.AGENTCHAT_API_BASE
    // A self-hosted user can move the same key to a different API base. Keying
    // the cache on the credential alone left the old client pointed at the old
    // server until the MCP process restarted.
    const signature = `${id.apiKey}\u0000${apiBase}`
    if (signature === this.identitySignature) return

    // Key changed (or first use) — rebuild. Synchronous, no I/O.
    this.identitySignature = signature
    this.client = new AgentChatClient({
      apiKey: id.apiKey,
      baseUrl: apiBase,
      fetch: this.fetchImpl,
    })
    this.handle = id.handle ?? '?'
    this.logger.info({ handle: this.handle }, 'AgentChat identity loaded')

    // Env-key deploys carry no handle on disk — resolve it once, non-blocking.
    if (!id.handle) {
      const c = this.client
      void c
        .getMe()
        .then((me) => {
          if (this.client === c) this.handle = me.handle
        })
        .catch(() => {
          // Leave '?' — a genuinely bad key surfaces on the first real call.
        })
    }
  }

  /** The client for whatever identity is on disk now; throws if there's none. */
  getClientOrThrow(): AgentChatClient {
    this.refresh()
    if (!this.client) throw new NotRegisteredError()
    return this.client
  }

  getSelfHandle(): string {
    this.refresh()
    return this.handle
  }

  /**
   * Raw REST view of the CURRENT identity, resolved freshly like the client:
   * the identity's api_base (or the configured default) plus its key, or a
   * key-less view of the default base when no identity exists yet — that's
   * what lets agentchat_register run before any sign-in.
   */
  getRest(): RestContext {
    const id = resolveIdentity()
    return {
      apiBase: id?.apiBase ?? this.config.AGENTCHAT_API_BASE,
      apiKey: id?.apiKey ?? null,
      fetchImpl: this.fetchImpl,
    }
  }
}

// ─── Fixed identity (hosted core) ───────────────────────────────────────────
//
// The hosted composition binds ONE identity per built server: whatever key
// the HTTP session presented (or none). Nothing here reads process.env or
// the filesystem — the transport layer composes headers → opts, mirroring
// how the stdio entry composes env → config.

export interface FixedIdentityOptions {
  apiBase: string
  /** null = unauthenticated session (registration tools still work). */
  apiKey: string | null
  fetchImpl: typeof fetch
}

export class FixedIdentityProvider implements IdentitySource {
  private readonly client: AgentChatClient | null
  private handle = '?'
  private handleFetchStarted = false

  constructor(private readonly options: FixedIdentityOptions) {
    this.client =
      options.apiKey === null
        ? null
        : new AgentChatClient({
            apiKey: options.apiKey,
            baseUrl: options.apiBase,
            fetch: options.fetchImpl,
          })
  }

  /**
   * The session carries a key but no handle; resolve it once, in the
   * background, the first time something actually asks for the handle.
   * Deliberately NOT in the constructor: hosted gateways may build a server
   * per HTTP request, and an eager getMe() would double their API traffic.
   * Until it lands (or if the key is bad) the placeholder '?' matches the
   * behavior of a bare AGENTCHAT_API_KEY stdio deploy.
   */
  private ensureHandleFetch(): void {
    if (this.handleFetchStarted || !this.client) return
    this.handleFetchStarted = true
    void this.client
      .getMe()
      .then((me) => {
        this.handle = me.handle
      })
      .catch(() => {
        // Leave '?' — a genuinely bad key surfaces on the first real call.
      })
  }

  getClientOrThrow(): AgentChatClient {
    if (!this.client) throw new NotAuthenticatedError()
    return this.client
  }

  getSelfHandle(): string {
    this.ensureHandleFetch()
    return this.handle
  }

  getRest(): RestContext {
    return {
      apiBase: this.options.apiBase,
      apiKey: this.options.apiKey,
      fetchImpl: this.options.fetchImpl,
    }
  }
}

/** Default product identity for hosted sessions (stdio reads it from env). */
export function defaultMcpFetch(base: typeof fetch = globalThis.fetch): typeof fetch {
  return withMcpClientIdentity(base, { name: 'mcp', version: PACKAGE_VERSION })
}

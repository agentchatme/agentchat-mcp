import { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import {
  IdentityConflictError,
  resolveIdentity,
  saveCredentials,
  type Config,
  type Identity,
  type NewCredentials,
  type SaveCredentialsResult,
} from './env.js'
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

/** What the stdio server finds at boot, for its first log line. */
export type IdentityStatus =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'conflict'; message: string }

export class IdentityProvider implements IdentitySource {
  private identitySignature: string | null = null
  private client: AgentChatClient | null = null
  private handle = '?'
  /** The last refusal, so it is logged once rather than on every call. */
  private loggedConflict: string | null = null

  constructor(
    private readonly config: IdentityConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve the base fetch LATE — at client-build / REST-read time, never at
   * construction. Instrumentation layers and test stubs that patch
   * `globalThis.fetch` after the provider exists are a supported (and
   * previously working) pattern; capturing fetch once in the constructor
   * silently pinned the pre-patch implementation for the process lifetime.
   * The hosted composition is different by design: it INJECTS an explicit
   * fetchImpl into FixedIdentityProvider and is untouched by this.
   */
  private buildFetch(): typeof fetch {
    return withMcpClientIdentity(globalThis.fetch, {
      name: this.config.AGENTCHAT_CLIENT_NAME ?? 'mcp',
      version: this.config.AGENTCHAT_CLIENT_VERSION,
    })
  }

  /** For a friendly boot log — is an identity resolvable right now? */
  hasIdentity(): boolean {
    return this.status().kind === 'present'
  }

  /** The identity situation right now: present, absent, or refused (and why). */
  status(): IdentityStatus {
    try {
      return resolveIdentity() === null ? { kind: 'absent' } : { kind: 'present' }
    } catch (err) {
      if (err instanceof IdentityConflictError) return { kind: 'conflict', message: err.message }
      throw err
    }
  }

  /**
   * The identity now, or null when there is none or it is refused. A refusal
   * (IdentityConflictError) is returned as `conflict` for the caller that
   * must surface it; it is logged once per distinct situation.
   */
  private resolve(): { id: Identity | null; conflict: IdentityConflictError | null } {
    try {
      const id = resolveIdentity()
      this.loggedConflict = null
      return { id, conflict: null }
    } catch (err) {
      if (!(err instanceof IdentityConflictError)) throw err
      if (this.loggedConflict !== err.message) {
        this.loggedConflict = err.message
        this.logger.warn({ kind: err.kind, home: err.home }, 'AgentChat identity refused: AGENTCHAT_API_KEY does not match the home')
      }
      return { id: null, conflict: err }
    }
  }

  private refresh(): void {
    const { id, conflict } = this.resolve()
    if (!id) {
      this.identitySignature = null
      this.client = null
      this.handle = '?'
      if (conflict) throw conflict
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
      fetch: this.buildFetch(),
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
    try {
      this.refresh()
    } catch (err) {
      // A refused identity has no handle; the tool that needs the client
      // surfaces the refusal itself.
      if (!(err instanceof IdentityConflictError)) throw err
    }
    return this.handle
  }

  /**
   * The CURRENT identity as plain values, resolved freshly like the client:
   * the identity's api_base (or the configured default) plus its key, or a
   * key-less view of the default base when no identity exists yet — that's
   * what lets agentchat_register run before any sign-in. A refused identity
   * (IdentityConflictError) is key-less here too: the sign-up pair still
   * works, and every call that needs the key reaches `getClientOrThrow`,
   * which throws the refusal.
   */
  getRest(): RestContext {
    const { id } = this.resolve()
    return {
      apiBase: id?.apiBase ?? this.config.AGENTCHAT_API_BASE,
      apiKey: id?.apiKey ?? null,
      fetchImpl: this.buildFetch(),
    }
  }

  /**
   * Save a key this server's own sign-up minted into its home's credentials
   * file (env.ts saveCredentials: owner-only, never replacing a key), and
   * say whether the environment's AGENTCHAT_API_KEY would then refuse it.
   */
  saveKey(creds: NewCredentials): SaveKeyResult {
    const result = saveCredentials(process.env, creds)
    if (!result.saved) return result
    const status = this.status()
    return { ...result, conflict: status.kind === 'conflict' ? status.message : null }
  }
}

/** saveCredentials' answer, plus the refusal (its message) the saved key now meets, if any. */
export type SaveKeyResult =
  | (Extract<SaveCredentialsResult, { saved: true }> & { conflict: string | null })
  | Extract<SaveCredentialsResult, { saved: false }>

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
  /**
   * The session's known handle (with or without the leading `@`), when the
   * caller already authenticated the key and knows it. Provided, it is
   * returned by getSelfHandle() immediately and NO background getMe() ever
   * fires — essential for per-request hosted servers, whose first tool call
   * would otherwise see the `'?'` placeholder and misclassify the agent's
   * own messages as peer messages.
   */
  selfHandle?: string
}

export class FixedIdentityProvider implements IdentitySource {
  private readonly client: AgentChatClient | null
  private handle: string
  private handleFetchStarted = false

  constructor(private readonly options: FixedIdentityOptions) {
    this.handle = options.selfHandle ?? '?'
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
   * behavior of a bare AGENTCHAT_API_KEY stdio deploy. When the caller
   * supplied `selfHandle`, or an earlier fetch already resolved the handle,
   * this is a no-op.
   */
  private ensureHandleFetch(): void {
    if (this.handle !== '?' || this.handleFetchStarted || !this.client) return
    this.handleFetchStarted = true
    void this.client
      .getMe()
      .then((me) => {
        this.handle = me.handle
      })
      .catch(() => {
        // Do NOT latch the failure: reset the flag so the next ask retries.
        // Latching left every later call stuck on '?' forever after one
        // transient failure. (A genuinely bad key still surfaces as a typed
        // error on the first real tool call.)
        this.handleFetchStarted = false
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

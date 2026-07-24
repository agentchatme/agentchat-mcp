import { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import { resolveIdentity, type Config } from './env.js'

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

export class IdentityProvider {
  private key: string | null = null
  private client: AgentChatClient | null = null
  private handle = '?'

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /** For a friendly boot log — is an identity resolvable right now? */
  hasIdentity(): boolean {
    return resolveIdentity() !== null
  }

  private refresh(): void {
    const id = resolveIdentity()
    if (!id) {
      this.key = null
      this.client = null
      this.handle = '?'
      return
    }
    if (id.apiKey === this.key) return

    // Key changed (or first use) — rebuild. Synchronous, no I/O.
    this.key = id.apiKey
    this.client = new AgentChatClient({
      apiKey: id.apiKey,
      baseUrl: id.apiBase ?? this.config.AGENTCHAT_API_BASE,
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
}

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'

// ─── Config + identity ──────────────────────────────────────────────────────
//
// Deliberately split:
//   * CONFIG (API base, concurrency, log level) is validated ONCE at startup —
//     a misconfigured deploy should still fail fast.
//   * IDENTITY (the API key) is resolved LAZILY and RE-READ on every tool call,
//     so a mid-session `agentchat register` / `login` is picked up WITHOUT
//     restarting the server. The server boots fine with no identity yet; tools
//     report "register first" until one appears. (This is what killed the
//     "restart your session so the tools see the new key" step.)
//
// AGENTCHAT_API_KEY (or a credentials file) is required to actually USE the
// tools, but never to START. AGENTCHAT_API_BASE defaults to production.

const ConfigSchema = z.object({
  AGENTCHAT_API_BASE: z.string().url().default('https://api.agentchat.me'),
  AGENTCHAT_MAX_CONCURRENT_TOOLS: z.coerce.number().int().min(1).max(100).default(10),
  AGENTCHAT_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  AGENTCHAT_CLIENT_NAME: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .default('mcp'),
  AGENTCHAT_CLIENT_VERSION: z
    .string()
    .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/)
    .optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvValidationError'
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new EnvValidationError(
      `AgentChat MCP config is invalid:\n${issues}\n\n` +
        `Optional: AGENTCHAT_API_BASE, AGENTCHAT_MAX_CONCURRENT_TOOLS, AGENTCHAT_LOG_LEVEL.`,
    )
  }
  return parsed.data
}

// ─── Identity resolution (re-read every call) ────────────────────────────────
//
// Two places can name the agent this server acts as: the home's
// `credentials` file (AGENTCHAT_HOME, else ~/.agentchat — what
// `agentchat register` / `login` and this server's own agentchat_verify_otp
// write) and an AGENTCHAT_API_KEY in the server's environment. The
// environment is easy to inherit by accident: a key exported in the shell
// that started the MCP host reaches every stdio server it spawns. So the
// environment's key is used only where it cannot silently replace the agent
// a home names (the same rule as the CLI listener's, agentchat-cli
// src/guards.ts):
//
//   * no AGENTCHAT_API_KEY             → the home's key, or no identity yet
//   * the home holds the same key      → that identity (with the file's handle)
//   * the home holds a different key   → refused: IdentityConflictError
//   * AGENTCHAT_HOME names a home that holds no key → refused, likewise
//   * neither AGENTCHAT_HOME nor a credentials file in ~/.agentchat → the
//     environment's key (an env-only deploy, as before)
//
// A refusal is not an error of the call: every tool answers IDENTITY_CONFLICT
// with the two ways out, and the sign-up pair still works (it needs no key).

export interface Identity {
  apiKey: string
  apiBase?: string
  /** Present when read from a credentials file (the CLI writes it); absent for
   *  a bare AGENTCHAT_API_KEY env deploy. */
  handle?: string
}

interface CredentialsFile {
  api_key?: string
  api_base?: string
  handle?: string
}

const MIN_KEY_LEN = 20

/** The default identity home, as the CLI and the coding-agent integrations name it. */
export const DEFAULT_HOME_DIRNAME = '.agentchat'

/** The home this server reads its identity from, and whether AGENTCHAT_HOME named it. */
export function identityHome(source: NodeJS.ProcessEnv = process.env): { home: string; explicit: boolean } {
  const named = source['AGENTCHAT_HOME']?.trim()
  if (named) return { home: path.resolve(named), explicit: true }
  return { home: path.join(os.homedir(), DEFAULT_HOME_DIRNAME), explicit: false }
}

export function credentialsPathOf(home: string): string {
  return path.join(home, 'credentials')
}

function readCredentialsFile(home: string): CredentialsFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(credentialsPathOf(home), 'utf-8'))
    if (parsed && typeof parsed === 'object') return parsed as CredentialsFile
  } catch {
    // absent or unreadable — no identity from the file
  }
  return null
}

function usableKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  return key.length >= MIN_KEY_LEN ? key : null
}

/** The environment's API key, trimmed, or null when it is absent or too short to be one. */
export function envApiKey(source: NodeJS.ProcessEnv = process.env): string | null {
  return usableKey(source['AGENTCHAT_API_KEY'])
}

/**
 * The environment's AGENTCHAT_API_KEY would make this server act as an agent
 * other than the one its home names. `kind`: `differs` — the home holds
 * another agent's key; `home_empty` — AGENTCHAT_HOME names a home that holds
 * no key. The message is the whole answer a tool gives (IDENTITY_CONFLICT):
 * what is wrong, and the two ways out. It never contains a key.
 */
export class IdentityConflictError extends Error {
  readonly code = 'IDENTITY_CONFLICT'

  constructor(
    readonly kind: 'differs' | 'home_empty',
    readonly home: string,
    readonly homeHandle: string | null,
  ) {
    super(conflictMessage(kind, home, homeHandle))
    this.name = 'IdentityConflictError'
  }
}

function conflictMessage(kind: 'differs' | 'home_empty', home: string, handle: string | null): string {
  const file = credentialsPathOf(home)
  const unset =
    'remove AGENTCHAT_API_KEY from the environment your MCP host starts this server with (its env settings for this server, or the shell the host was started from)'
  if (kind === 'differs') {
    const who = handle ? `@${handle.replace(/^@/, '')}` : 'the agent that file names'
    return (
      `This server’s environment has AGENTCHAT_API_KEY, and it is not the key in ${file}: they are two different agents, and this server will not pick one silently. ` +
      `To act as ${who}, ${unset}. ` +
      `To act as the agent of that environment key instead, give it a home of its own: set AGENTCHAT_HOME to a new folder, sign in there (\`agentchat login --api-key -\` reads the key from stdin), then remove AGENTCHAT_API_KEY. ` +
      'The next call picks up the change; no restart.'
    )
  }
  return (
    `AGENTCHAT_HOME names ${home}, which holds no AgentChat key, but this server’s environment has AGENTCHAT_API_KEY; this server acts only as the agent its home names and will not take the environment’s key silently. ` +
    `Either sign this home in (agentchat_register, then agentchat_verify_otp, which saves the key there; or \`agentchat login --api-key -\`, which reads it from stdin) and ${unset}, ` +
    'or remove AGENTCHAT_HOME from that environment to use the environment key. The next call picks up the change; no restart.'
  )
}

/**
 * Resolve the CURRENT identity, freshly, each time it's called (see the
 * table above). Returns null when there's no usable identity yet — the
 * caller surfaces that as a "register first" tool error, not a crash — and
 * throws IdentityConflictError when the environment's key would silently
 * replace the agent the home names.
 */
export function resolveIdentity(source: NodeJS.ProcessEnv = process.env): Identity | null {
  const envKey = envApiKey(source)
  const envBase = source['AGENTCHAT_API_BASE']
  const { home, explicit } = identityHome(source)
  const file = readCredentialsFile(home)
  const fileKey = usableKey(file?.api_key)
  const fileHandle = typeof file?.handle === 'string' && file.handle.length > 0 ? file.handle : null

  if (envKey !== null) {
    if (fileKey !== null) {
      if (fileKey !== envKey) throw new IdentityConflictError('differs', home, fileHandle)
      // The same agent both ways: as before, the environment's base wins.
      const apiBase = envBase || file?.api_base
      return {
        apiKey: envKey,
        ...(apiBase ? { apiBase } : {}),
        ...(fileHandle ? { handle: fileHandle } : {}),
      }
    }
    if (explicit) throw new IdentityConflictError('home_empty', home, null)
    return { apiKey: envKey, ...(envBase ? { apiBase: envBase } : {}) }
  }
  if (fileKey !== null) {
    return {
      apiKey: fileKey,
      ...(file?.api_base ? { apiBase: file.api_base } : {}),
      ...(fileHandle ? { handle: fileHandle } : {}),
    }
  }
  return null
}

// ─── Saving a minted key (the stdio server's own sign-up) ───────────────────
//
// agentchat_verify_otp on the stdio server writes the key it minted straight
// into the home's credentials file, so the key never has to pass through
// the model, a command line or an environment variable. The file is the
// shape the CLI and the coding-agent integrations read (agent-core's
// Credentials: api_key, handle, api_base?, created_at?), owner-only (0600),
// in a home created owner-only (0700).
//
// It never replaces a key: a home that already holds one (another agent's,
// or a file it cannot read) is left exactly as it is, and the caller hands
// the key back instead. The file is written beside its final name and then
// hard-linked into place, which fails if a file appeared there meanwhile, so
// two concurrent sign-ups cannot overwrite each other either.

export type SaveCredentialsResult =
  | { saved: true; path: string; alreadyThere: boolean }
  | { saved: false; path: string; reason: string }

export interface NewCredentials {
  apiKey: string
  handle: string
  /** Written only when it is not the default production base. */
  apiBase?: string
}

const DEFAULT_API_BASE = 'https://api.agentchat.me'

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

export function saveCredentials(
  source: NodeJS.ProcessEnv,
  creds: NewCredentials,
): SaveCredentialsResult {
  const { home } = identityHome(source)
  const target = credentialsPathOf(home)
  const existing = (() => {
    try {
      return fs.readFileSync(target, 'utf-8')
    } catch (err) {
      return errnoOf(err) === 'ENOENT' ? null : err
    }
  })()
  if (existing instanceof Error) {
    return { saved: false, path: target, reason: `${target} exists but could not be read (${errnoOf(existing) ?? existing.message}), so it was left as it is` }
  }
  if (typeof existing === 'string') {
    let held: CredentialsFile | null = null
    try {
      held = JSON.parse(existing) as CredentialsFile
    } catch {
      held = null
    }
    if (usableKey(held?.api_key) === creds.apiKey) return { saved: true, path: target, alreadyThere: true }
    const who = typeof held?.handle === 'string' && held.handle.length > 0 ? ` (@${held.handle.replace(/^@/, '')})` : ''
    return { saved: false, path: target, reason: `${target} already holds another agent’s key${who}; it was left as it is` }
  }

  const base = creds.apiBase?.replace(/\/+$/, '')
  const body =
    JSON.stringify(
      {
        api_key: creds.apiKey,
        handle: creds.handle.replace(/^@/, ''),
        ...(base && base !== DEFAULT_API_BASE ? { api_base: base } : {}),
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n'
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.linkSync(temp, target)
    } catch (err) {
      if (errnoOf(err) === 'EEXIST') {
        return { saved: false, path: target, reason: `${target} appeared while saving (another sign-in); it was left as it is` }
      }
      // A file system without hard links: copy, still refusing to replace.
      fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, 0o600)
    }
    return { saved: true, path: target, alreadyThere: false }
  } catch (err) {
    const why = errnoOf(err) === 'EEXIST' ? 'a file appeared there while saving' : (errnoOf(err) ?? (err instanceof Error ? err.message : String(err)))
    return { saved: false, path: target, reason: `the key could not be saved in ${target} (${why})` }
  } finally {
    try {
      fs.unlinkSync(temp)
    } catch {
      // never created, or already gone
    }
  }
}

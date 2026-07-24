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

function readCredentialsFile(source: NodeJS.ProcessEnv): CredentialsFile | null {
  const home = source['AGENTCHAT_HOME']?.trim()
    ? path.resolve(source['AGENTCHAT_HOME']!.trim())
    : path.join(os.homedir(), '.agentchat')
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(home, 'credentials'), 'utf-8'))
    if (parsed && typeof parsed === 'object') return parsed as CredentialsFile
  } catch {
    // absent or unreadable — no identity from the file
  }
  return null
}

/**
 * Resolve the CURRENT identity, freshly, each time it's called: an explicit
 * AGENTCHAT_API_KEY env wins; otherwise the credentials file written by
 * `agentchat register` / `login` (via AGENTCHAT_HOME or ~/.agentchat). Returns
 * null when there's no usable identity yet — the caller surfaces that as a
 * "register first" tool error, not a crash.
 */
export function resolveIdentity(source: NodeJS.ProcessEnv = process.env): Identity | null {
  const envKey = source['AGENTCHAT_API_KEY']
  if (envKey && envKey.length >= MIN_KEY_LEN) {
    const apiBase = source['AGENTCHAT_API_BASE']
    return { apiKey: envKey, ...(apiBase ? { apiBase } : {}) }
  }
  const file = readCredentialsFile(source)
  if (file?.api_key && file.api_key.length >= MIN_KEY_LEN) {
    return {
      apiKey: file.api_key,
      ...(file.api_base ? { apiBase: file.api_base } : {}),
      ...(file.handle ? { handle: file.handle } : {}),
    }
  }
  return null
}

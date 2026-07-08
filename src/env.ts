import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'

// ─── Environment validation ────────────────────────────────────────────────
//
// We validate environment variables at startup, not lazily on first use,
// so a misconfigured deploy fails immediately with a clear error rather
// than at the moment a tool is invoked.
//
// AGENTCHAT_API_KEY is required. Format is `ac_live_…` or `ac_test_…` —
// we don't enforce the prefix here so internal staging keys still work,
// but we do enforce a minimum length to catch the common case of an
// empty string from a missing env var.
//
// AGENTCHAT_API_BASE is optional — defaults to the production endpoint.
// Override only for self-hosted instances.
//
// AGENTCHAT_MAX_CONCURRENT_TOOLS is the backpressure ceiling. The MCP
// host can request many tool calls in parallel; without a cap, an
// aggressive host could burn the agent's per-second rate-limit budget
// faster than necessary. Default 10 is comfortable for any realistic
// MCP client load and well under the 60 msg/sec server-side cap.
//
// AGENTCHAT_LOG_LEVEL controls pino's log level. Default 'info'.

const EnvSchema = z.object({
  AGENTCHAT_API_KEY: z
    .string()
    .min(20, 'AGENTCHAT_API_KEY must be at least 20 characters'),
  AGENTCHAT_API_BASE: z
    .string()
    .url()
    .default('https://api.agentchat.me'),
  AGENTCHAT_MAX_CONCURRENT_TOOLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
  AGENTCHAT_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
})

export type Env = z.infer<typeof EnvSchema>

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvValidationError'
  }
}

// ─── ~/.agentchat/credentials fallback ──────────────────────────────────────
//
// The @agentchatme/cli wizard (used by the Claude Code / Codex / Cursor
// plugins) stores one machine-wide identity at ~/.agentchat/credentials.
// When the host config doesn't pass AGENTCHAT_API_KEY explicitly, we fall
// back to that file so all plugins and this server share a single sign-in.
// Env always wins; AGENTCHAT_HOME overrides the directory (tests, multi-
// identity setups).

interface CredentialsFile {
  api_key?: string
  api_base?: string
}

function readCredentialsFallback(source: NodeJS.ProcessEnv): CredentialsFile | null {
  const home = source['AGENTCHAT_HOME']?.trim()
    ? path.resolve(source['AGENTCHAT_HOME']!.trim())
    : path.join(os.homedir(), '.agentchat')
  try {
    const raw = fs.readFileSync(path.join(home, 'credentials'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as CredentialsFile
  } catch {
    // absent or unreadable — the schema error below explains what to do
  }
  return null
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  let effective = source
  let usedFileIdentity = false
  let fileWasPresent = false
  const envKey = source['AGENTCHAT_API_KEY']
  if (!envKey || envKey.length < 20) {
    const file = readCredentialsFallback(source)
    fileWasPresent = file !== null
    if (file?.api_key) {
      usedFileIdentity = true
      // A SET-but-malformed env key silently losing to the file would be an
      // unnoticed identity swap on a messaging platform — say it out loud.
      // stdout is reserved for JSON-RPC; stderr is the log channel.
      if (envKey && envKey.length > 0) {
        process.stderr.write(
          '[agentchat-mcp] AGENTCHAT_API_KEY is set but malformed (under 20 chars); ' +
            'using the ~/.agentchat/credentials identity instead.\n',
        )
      }
      effective = {
        ...source,
        AGENTCHAT_API_KEY: file.api_key,
        // File api_base applies only when the env didn't set one.
        ...(source['AGENTCHAT_API_BASE'] || !file.api_base
          ? {}
          : { AGENTCHAT_API_BASE: file.api_base }),
      }
    }
  }

  const parsed = EnvSchema.safeParse(effective)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    const fileHint =
      fileWasPresent && !usedFileIdentity
        ? `Note: a ~/.agentchat/credentials file exists but its api_key is missing or invalid — re-run \`agentchat login\` or \`agentchat register\`.\n`
        : usedFileIdentity
          ? `Note: the failing value came from ~/.agentchat/credentials, not your MCP host config.\n`
          : ''
    throw new EnvValidationError(
      `AgentChat MCP server failed to start — environment is invalid:\n${issues}\n\n` +
        fileHint +
        `Required: AGENTCHAT_API_KEY (your ac_live_… key from https://agentchat.me),\n` +
        `or a machine identity at ~/.agentchat/credentials (created by \`agentchat register\`).\n` +
        `Optional: AGENTCHAT_API_BASE, AGENTCHAT_MAX_CONCURRENT_TOOLS, AGENTCHAT_LOG_LEVEL.`,
    )
  }
  return parsed.data
}

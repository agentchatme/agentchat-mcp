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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new EnvValidationError(
      `AgentChat MCP server failed to start — environment is invalid:\n${issues}\n\n` +
        `Required: AGENTCHAT_API_KEY (your ac_live_… key from https://agentchat.me).\n` +
        `Optional: AGENTCHAT_API_BASE, AGENTCHAT_MAX_CONCURRENT_TOOLS, AGENTCHAT_LOG_LEVEL.`,
    )
  }
  return parsed.data
}

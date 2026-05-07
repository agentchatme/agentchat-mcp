import pino, { type Logger } from 'pino'
import type { Env } from './env.js'

// ─── Structured logging to stderr ──────────────────────────────────────────
//
// CRITICAL invariant for stdio MCP servers: stdout is reserved for JSON-RPC
// frames. Any stray write to stdout corrupts the protocol stream and the
// MCP host disconnects. All logs MUST go to stderr.
//
// We use pino's `destination(2)` (stderr file descriptor) explicitly so that
// even if a transport plugin or sub-logger is misconfigured, the wire stays
// clean. We also set `process.env['PINO_DESTINATION']` — pino respects it
// and any deps that grab a default pino logger inherit our setup rather
// than writing to stdout themselves.
//
// Redaction: we redact authorization-shaped values out of structured logs
// as defense-in-depth. We do not log full message content at info level —
// only handle/conversation_id/seq, never the body — so a leaked log file
// cannot leak conversations.

export interface LoggerConfig {
  level: Env['AGENTCHAT_LOG_LEVEL']
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(
    {
      level: config.level,
      base: { service: 'agentchat-mcp' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'apiKey',
          'api_key',
          'authorization',
          'Authorization',
          '*.apiKey',
          '*.api_key',
          '*.authorization',
          'headers.authorization',
          'headers.Authorization',
        ],
        censor: '[REDACTED]',
      },
      formatters: {
        // Lower-case `level` field (e.g. 'info') reads cleaner in log
        // pipelines than pino's default numeric levels (e.g. 30).
        level: (label) => ({ level: label }),
      },
    },
    pino.destination(2),
  )
}

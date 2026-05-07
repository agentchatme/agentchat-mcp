import { UnauthorizedError } from 'agentchatme'
import { bootClient } from './client.js'
import { EnvValidationError, loadEnv } from './env.js'
import { createLogger } from './log.js'
import { buildServer } from './server.js'
import { PACKAGE_VERSION } from './version.js'

// ─── Entry point ───────────────────────────────────────────────────────────
//
// Boot order:
//   1. Validate env (AGENTCHAT_API_KEY required). Fail fast with a
//      human-readable error to stderr if missing.
//   2. Construct logger to stderr. stdout is reserved for JSON-RPC.
//   3. Authenticate against AgentChat by calling getMe(). Confirms the
//      key is valid before we bind the stdio transport — this turns a
//      misconfigured key into a clear startup failure rather than a
//      confusing tool-call failure later.
//   4. Build the MCP server, register tools, connect stdio.
//   5. Wire SIGTERM/SIGINT handlers for graceful shutdown.
//
// Any failure in steps 1–3 exits with code 1 after writing a structured
// error message to stderr. The MCP host surfaces the stderr to the user.

async function main(): Promise<void> {
  let env: ReturnType<typeof loadEnv>
  try {
    env = loadEnv()
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Friendly stderr write — no logger yet, the env failure happened
      // before we could construct one.
      process.stderr.write(`\n${err.message}\n\n`)
      process.exit(1)
    }
    throw err
  }

  const logger = createLogger({ level: env.AGENTCHAT_LOG_LEVEL })

  logger.info(
    { version: PACKAGE_VERSION, node: process.versions.node },
    'agentchat-mcp starting',
  )

  let booted: Awaited<ReturnType<typeof bootClient>>
  try {
    booted = await bootClient(env, logger)
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      logger.fatal(
        'AGENTCHAT_API_KEY rejected by api.agentchat.me. The key may be invalid, rotated, revoked, or pointed at a different environment via AGENTCHAT_API_BASE.',
      )
      process.exit(1)
    }
    logger.fatal({ err }, 'failed to authenticate with AgentChat at startup')
    process.exit(1)
  }

  const built = buildServer(booted, logger)

  // Wire shutdown BEFORE serve so signals received during the connect()
  // race land cleanly.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')
    try {
      await built.close()
    } finally {
      // Force-exit after a small drain budget. stdio MCP servers are
      // subprocess of the host; the host has already gone away by this
      // point, so we don't need to wait long.
      setTimeout(() => process.exit(0), 1_000).unref()
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception')
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection')
    // Don't exit on unhandled rejection — log loudly and let the
    // affected tool call's withErrorBoundary handle the user-visible
    // failure. Crashing the whole server here would be worse UX.
  })

  await built.serve()

  // McpServer's connect() resolves when the transport is bound. The
  // process keeps running because the stdin handle keeps the event loop
  // alive. The shutdown path above takes over on signal or stdin close.
}

void main()

import { IdentityProvider } from './client.js'
import { EnvValidationError, loadConfig } from './env.js'
import { createLogger } from './log.js'
import { buildServer } from './server.js'
import { PACKAGE_VERSION } from './version.js'

// ─── Entry point ───────────────────────────────────────────────────────────
//
// Boot order:
//   1. Validate env (AGENTCHAT_API_KEY required). Fail fast with a
//      human-readable error to stderr if missing.
//   2. Construct logger to stderr. stdout is reserved for JSON-RPC.
//   3. Authenticate with AgentChat (with bounded retry on transient
//      ConnectionError so a network blip during MCP-host startup doesn't
//      kill the server permanently). Fail fast on UnauthorizedError —
//      that's configuration, not transient.
//   4. Build the MCP server, register tools, connect stdio.
//   5. Wire SIGTERM/SIGINT handlers for graceful shutdown — drain
//      in-flight tool calls (deadline 10s) before closing the transport.

const SHUTDOWN_DRAIN_MS = 10_000

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Friendly stderr write — no logger yet, the failure happened before we
      // could construct one. (Only CONFIG can fail here; a missing identity
      // never blocks startup — see below.)
      process.stderr.write(`\n${err.message}\n\n`)
      process.exit(1)
    }
    throw err
  }

  const logger = createLogger({ level: config.AGENTCHAT_LOG_LEVEL })

  logger.info(
    { version: PACKAGE_VERSION, node: process.versions.node },
    'agentchat-mcp starting',
  )

  // The identity is resolved lazily, per tool call. The server starts whether
  // or not one exists yet: a fresh install has no key until `agentchat
  // register` runs mid-session, and we pick that up on the next tool call with
  // NO restart. Just log which state we booted in.
  const provider = new IdentityProvider(config, logger)
  if (provider.hasIdentity()) {
    logger.info('AgentChat identity present')
  } else {
    logger.warn(
      'no AgentChat identity yet — tools return NOT_REGISTERED until you run `agentchat register` (or `login`); it takes effect immediately, no restart',
    )
  }

  const built = buildServer(provider, config, logger)

  // Wire shutdown BEFORE serve so signals received during the connect()
  // race land cleanly.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutdown initiated')

    // 1. Drain in-flight tool calls. New calls arriving past this point
    //    will land on a server that is closing — they fail at the MCP
    //    transport layer, which the host can interpret. We do not start
    //    closing the transport until in-flight has drained (or hit the
    //    deadline) so we don't yank a tool out of its work.
    try {
      await built.drain(SHUTDOWN_DRAIN_MS)
    } catch (err) {
      logger.warn({ err }, 'drain errored; proceeding to close')
    }

    // 2. Close the MCP server transport.
    try {
      await built.close()
    } catch (err) {
      logger.warn({ err }, 'close errored')
    }

    // 3. Force-exit shortly after. Anything still on the event loop at
    //    this point is a leaked timer/handle that would block exit
    //    indefinitely.
    setTimeout(() => process.exit(0), 1_000).unref()
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

void main().catch((err: unknown) => {
  // Catch-all for anything that escapes main()'s own try/catches. We
  // don't have a logger constructed in every failure path so write to
  // stderr unconditionally before exiting non-zero.
  process.stderr.write(
    `\nFatal: agentchat-mcp main loop rejected with ${
      err instanceof Error ? err.message : String(err)
    }\n\n`,
  )
  process.exit(1)
})

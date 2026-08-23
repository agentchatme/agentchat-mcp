import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Logger } from 'pino'
import type { IdentityProvider } from './client.js'
import type { Config } from './env.js'
import type { ToolContext } from './tools/_types.js'
import { buildInstructions } from './instructions.js'
import { Semaphore } from './semaphore.js'
import { registerAllTools, TOOL_COUNT } from './tools/index.js'
import { PACKAGE_VERSION } from './version.js'

// ─── MCP server construction & lifecycle ───────────────────────────────────
//
// Uses the high-level McpServer API from @modelcontextprotocol/sdk, which:
//   - converts our Zod tool schemas to JSON Schema for tools/list responses
//   - dispatches incoming tools/call requests to the right handler
//   - handles JSON-RPC framing on stdio for us
//
// Lifecycle:
//   - buildServer(...) constructs the McpServer, the concurrency semaphore,
//     and the in-flight tracker, and registers all tools against them.
//   - serve() binds the stdio transport and waits for traffic.
//   - drain(deadlineMs) waits for in-flight tool calls to complete with a
//     bounded deadline, then close() shuts the server down.
//
// Graceful shutdown is driven by SIGTERM/SIGINT signal handlers in
// index.ts, which call drain() then close() in order.

export interface BuiltServer {
  server: McpServer
  serve: () => Promise<void>
  drain: (deadlineMs: number) => Promise<{ drained: number; remaining: number }>
  close: () => Promise<void>
  /** For tests + diagnostics. */
  inflight: Set<Promise<unknown>>
  semaphore: Semaphore
}

export function buildServer(
  provider: IdentityProvider,
  config: Config,
  logger: Logger,
): BuiltServer {
  const server = new McpServer(
    {
      name: 'agentchat',
      version: PACKAGE_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions('stdio', TOOL_COUNT),
    },
  )

  // Concurrency gate. Configured via AGENTCHAT_MAX_CONCURRENT_TOOLS.
  const semaphore = new Semaphore(config.AGENTCHAT_MAX_CONCURRENT_TOOLS)

  // In-flight tracker — withErrorBoundary adds/removes per call.
  const inflight = new Set<Promise<unknown>>()

  // Live context: `client` and `selfHandle` are getters, so every tool call
  // resolves the identity that's on disk RIGHT NOW. A mid-session
  // register/login is picked up on the next call — no restart. (Throws
  // NotRegisteredError, mapped to a friendly message, when there's none yet.)
  const ctx: ToolContext = {
    get client() {
      return provider.getClientOrThrow()
    },
    get selfHandle() {
      return provider.getSelfHandle()
    },
    get rest() {
      return provider.getRest()
    },
    // Historical env contract, read at call time exactly as before the
    // core/transport split — always-on integrations set this per process.
    turnKey: () => process.env['AGENTCHAT_TURN_IDEMPOTENCY_KEY']?.trim(),
    logger,
    semaphore,
    inflight,
  }
  registerAllTools(server, ctx)

  const transport = new StdioServerTransport()

  return {
    server,
    serve: async () => {
      await server.connect(transport)
      logger.info(
        {
          tools: TOOL_COUNT,
          maxConcurrent: config.AGENTCHAT_MAX_CONCURRENT_TOOLS,
        },
        'mcp server connected on stdio',
      )
    },
    drain: async (deadlineMs) => {
      const startInflight = inflight.size
      if (startInflight === 0) {
        return { drained: 0, remaining: 0 }
      }
      logger.info({ inflight: startInflight, deadlineMs }, 'draining in-flight tool calls')

      // Race the inflight set against a deadline. Any survivor at deadline
      // is a tool call mid-flight at SIGTERM that didn't complete in time.
      // We don't kill it — the process exit will close the socket and
      // its server-side request will either complete (and the response
      // is dropped) or error out cleanly.
      const settled = Promise.allSettled(Array.from(inflight))
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), deadlineMs).unref()
      })
      const result = await Promise.race([settled, timeout])

      const remaining = inflight.size
      const drained = startInflight - remaining
      if (result === 'timeout' && remaining > 0) {
        logger.warn(
          { drained, remaining, deadlineMs },
          'drain deadline exceeded; some in-flight calls did not complete',
        )
      } else {
        logger.info({ drained }, 'drain complete')
      }
      return { drained, remaining }
    },
    close: async () => {
      await server.close().catch((err: unknown) => {
        logger.warn({ err }, 'mcp server close errored')
      })
    },
    inflight,
    semaphore,
  }
}

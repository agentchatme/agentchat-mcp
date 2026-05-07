import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'
import type { Semaphore } from '../semaphore.js'

// ─── Tool registration contract ────────────────────────────────────────────
//
// Each tool file exports `NAME`, `INPUT_SHAPE`, `createHandler`, and
// `register`. Splitting the handler factory from the registration is
// deliberate: tests construct handlers directly with a stubbed client and
// assert call shape, without needing to plug in the MCP transport.
//
// `inflight` is the shared Set of running tool-call promises. Tools push
// their work onto it via `withErrorBoundary`; shutdown awaits the set
// before exiting so SIGTERM never aborts a mid-flight API call. The set
// is mutable and lives across tool invocations — the boundary wrapper
// owns the add/remove discipline.

export interface ToolContext {
  client: AgentChatClient
  logger: Logger
  selfHandle: string
  semaphore: Semaphore
  inflight: Set<Promise<unknown>>
}

export type ToolRegistration = (server: McpServer, ctx: ToolContext) => void

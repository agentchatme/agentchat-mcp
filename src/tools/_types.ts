import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentChatClient } from 'agentchatme'
import type { Logger } from 'pino'

// ─── Tool registration contract ────────────────────────────────────────────
//
// Each tool file exports a `register` function with this signature. The
// server.ts iterates them and calls each, passing in shared context.
//
// We deliberately keep the context minimal — client + logger + selfHandle —
// so tools can be unit-tested with stubbed clients without dragging in
// MCP transport plumbing.

export interface ToolContext {
  client: AgentChatClient
  logger: Logger
  selfHandle: string
}

export type ToolRegistration = (server: McpServer, ctx: ToolContext) => void

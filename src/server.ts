import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Logger } from 'pino'
import type { BootedClient } from './client.js'
import { registerAllTools, TOOL_COUNT } from './tools/index.js'
import { PACKAGE_VERSION } from './version.js'

// ─── MCP server construction & lifecycle ───────────────────────────────────
//
// Uses the high-level McpServer API from @modelcontextprotocol/sdk, which:
//   - converts our zod tool schemas to JSON Schema for tools/list responses
//   - dispatches incoming tools/call requests to the right handler
//   - handles JSON-RPC framing on stdio for us
//
// Lifecycle is intentionally simple: build server, register tools, attach
// transport, await transport close. Graceful shutdown is driven by stdio
// EOF (the host closing the subprocess) plus SIGTERM/SIGINT signal handlers
// in index.ts.

export interface BuiltServer {
  server: McpServer
  serve: () => Promise<void>
  close: () => Promise<void>
}

export function buildServer(booted: BootedClient, logger: Logger): BuiltServer {
  const server = new McpServer(
    {
      name: 'agentchat',
      version: PACKAGE_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: [
        `AgentChat is an agent-to-agent messaging platform. This MCP server exposes ${TOOL_COUNT} tools you can use to participate in the network as your authenticated agent.`,
        '',
        `Your handle on the network is ${booted.selfHandle}. Other agents address you by that handle.`,
        '',
        'This MCP server is a polling-based universal-fallback connector. Inbound messages do not arrive in real time — call agentchat_list_inbox at the start of a turn to discover new messages, then agentchat_get_conversation to read a specific thread, then agentchat_mark_read after processing. If you are running on OpenClaw, the @agentchatme/openclaw native plugin gives you real-time WebSocket-based delivery instead.',
        '',
        'Etiquette: cold direct messages are 1-message-until-reply (a stricter rule than typical chat platforms — wait for the recipient to reply before sending a second message in the same thread). Group messages have no such restriction. Read agentchat_get_my_status if a send is rejected with ACCOUNT_RESTRICTED, ACCOUNT_SUSPENDED, or AWAITING_REPLY for guidance on what state your account is in.',
      ].join('\n'),
    },
  )

  registerAllTools(server, {
    client: booted.client,
    logger,
    selfHandle: booted.selfHandle,
  })

  const transport = new StdioServerTransport()

  return {
    server,
    serve: async () => {
      await server.connect(transport)
      logger.info({ tools: TOOL_COUNT }, 'mcp server connected on stdio')
    },
    close: async () => {
      await server.close().catch((err: unknown) => {
        // Best-effort close — log and continue. Anything that prevents a
        // clean close still terminates when the process exits.
        logger.warn({ err }, 'mcp server close errored')
      })
    },
  }
}

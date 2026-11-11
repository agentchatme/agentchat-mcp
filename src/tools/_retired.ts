import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import { z } from 'zod'
import * as listConversations from './list-conversations.js'
import * as respondToInvite from './respond-to-invite.js'
import type { ToolRegistration } from './_types.js'

// ─── Retired tool names: callable, never listed (plan §4c, old paths) ──────
//
// Phase 4 renamed agentchat_list_inbox → agentchat_list_conversations and
// merged agentchat_accept_group_invite + agentchat_reject_group_invite into
// agentchat_respond_to_invite. Texts already in the field (the served
// instructions, manual 2.1.2, the Hermes and OpenClaw bundles) still name
// the old tools, and rule 9 says a change never breaks an installed
// integration. So for one release the three old names stay CALLABLE as
// hidden aliases: each runs the new tool's handler with the matching input
// and appends one line naming the successor. They never appear in
// tools/list under any visibility, so no new caller learns them. Removed in
// the next minor.
//
// Hiding: the MCP SDK lists every enabled registered tool and refuses calls
// to disabled ones, so "callable but unlisted" needs the listing filtered
// after the fact. hideFromListing() wraps the SDK's own tools/list handler
// (replacing a handler is documented behavior) and drops the alias names
// from its result, so the schema conversion stays the SDK's. Reading the
// stored handler back is the one private touch: the protocol layer's
// `_requestHandlers` map. Three things keep it safe:
//   * package.json pins @modelcontextprotocol/sdk to one exact version (it
//     is a dependency, installed next to this package, not bundled), so the
//     version tested is the version an install gets;
//   * tests/tools/retired-aliases.test.ts fails if that version keeps the
//     handler anywhere else, and checks the pin is exact;
//   * if an install still ends up on an SDK without it (an embedder's
//     override), nothing breaks: the server starts as usual, the aliases
//     stay callable and are simply listed too, and one warning is logged.

export interface RetiredAlias {
  /** The retired name. */
  name: string
  /** The tool that does the job now. */
  successor: string
  /** Registers the alias on the server; the listing filter hides it. */
  register: ToolRegistration
}

function retiredLine(name: string, successor: string, how = ''): string {
  return `${name} is a retired name and is removed in the next minor: call ${successor}${how} instead.`
}

function withRetiredLine(result: CallToolResult, line: string): CallToolResult {
  return { ...result, content: [...result.content, { type: 'text', text: line }] }
}

const INVITE_SHAPE = {
  invite_id: z.string().min(1).describe('Invite id from agentchat_list_group_invites.'),
}

export const RETIRED_ALIASES: readonly RetiredAlias[] = [
  {
    name: 'agentchat_list_inbox',
    successor: listConversations.NAME,
    register: (server, ctx) => {
      const name = 'agentchat_list_inbox'
      const line = retiredLine(name, listConversations.NAME)
      const handler = listConversations.createHandler(ctx)
      server.registerTool(
        name,
        {
          description: `Retired name of ${listConversations.NAME}; call that instead. Removed in the next minor.`,
          inputSchema: listConversations.INPUT_SHAPE,
          annotations: listConversations.ANNOTATIONS,
        },
        async (input) => withRetiredLine(await handler(input), line),
      )
    },
  },
  {
    name: 'agentchat_accept_group_invite',
    successor: respondToInvite.NAME,
    register: (server, ctx) => {
      const name = 'agentchat_accept_group_invite'
      const line = retiredLine(name, respondToInvite.NAME, ' with response "accept"')
      const handler = respondToInvite.createHandler(ctx)
      server.registerTool(
        name,
        {
          description: `Retired name of ${respondToInvite.NAME} (response: accept); call that instead. Removed in the next minor.`,
          inputSchema: INVITE_SHAPE,
          annotations: respondToInvite.ANNOTATIONS,
        },
        async ({ invite_id }) =>
          withRetiredLine(await handler({ invite_id, response: 'accept' }), line),
      )
    },
  },
  {
    name: 'agentchat_reject_group_invite',
    successor: respondToInvite.NAME,
    register: (server, ctx) => {
      const name = 'agentchat_reject_group_invite'
      const line = retiredLine(name, respondToInvite.NAME, ' with response "decline"')
      const handler = respondToInvite.createHandler(ctx)
      server.registerTool(
        name,
        {
          description: `Retired name of ${respondToInvite.NAME} (response: decline); call that instead. Removed in the next minor.`,
          inputSchema: INVITE_SHAPE,
          annotations: respondToInvite.ANNOTATIONS,
        },
        async ({ invite_id }) =>
          withRetiredLine(await handler({ invite_id, response: 'decline' }), line),
      )
    },
  },
]

/** The retired names, in alias order. Never in tools/list. */
export const RETIRED_TOOL_NAMES: readonly string[] = RETIRED_ALIASES.map((alias) => alias.name)

type StoredHandler = (request: unknown, extra: unknown) => Promise<unknown>

/**
 * The MCP SDK's own tools/list handler, read from where SDK 1.x keeps it
 * (the protocol layer's `_requestHandlers` map), or null when this SDK keeps
 * it anywhere else. Never throws.
 */
export function storedListHandler(server: McpServer): StoredHandler | null {
  try {
    const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers
    if (!(handlers instanceof Map)) return null
    const stored: unknown = handlers.get('tools/list')
    return typeof stored === 'function' ? (stored as StoredHandler) : null
  } catch {
    return null
  }
}

/** The warning for an SDK without the hook, logged once per logger (see hideFromListing). */
export const UNHIDDEN_ALIASES_WARNING =
  'retired tool aliases stay listed: this MCP SDK keeps no tools/list handler where src/tools/_retired.ts reads it; they still work'

const warnedLoggers = new WeakSet<Logger>()

/**
 * Drop `names` from every tools/list answer while leaving them callable.
 * Call AFTER the tools are registered: the SDK installs its tools/list
 * handler on the first registration and refuses to be pre-empted.
 *
 * Returns true when the listing is filtered. On an MCP SDK that keeps its
 * handler elsewhere nothing is changed — the server starts as usual and the
 * names stay listed and callable — and `logger` gets one warning: once per
 * logger, so a hosted endpoint that builds a server per request logs it
 * once, not per request.
 */
export function hideFromListing(server: McpServer, names: readonly string[], logger: Logger): boolean {
  const hidden = new Set(names)
  const stored = storedListHandler(server)
  if (stored === null) {
    if (!warnedLoggers.has(logger)) {
      warnedLoggers.add(logger)
      logger.warn({ aliases: [...names] }, UNHIDDEN_ALIASES_WARNING)
    }
    return false
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = (await stored(request, extra)) as ListToolsResult
    // An answer of another shape (an SDK that changed it) goes out as the SDK
    // made it: the aliases may show, tools/list never breaks.
    if (typeof result !== 'object' || result === null || !Array.isArray(result.tools)) return result
    return { ...result, tools: result.tools.filter((tool) => !hidden.has(tool.name)) }
  })
  return true
}

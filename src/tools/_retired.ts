import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
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
// stored handler back is the one private touch, guarded by a loud error;
// the SDK is bundled into the published artifact, so the version tested is
// the version shipped, and tests/tools/retired-aliases.test.ts covers both
// halves (callable, unlisted).

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
 * Drop `names` from every tools/list answer while leaving them callable.
 * Call AFTER the tools are registered: the SDK installs its tools/list
 * handler on the first registration and refuses to be pre-empted.
 */
export function hideFromListing(server: McpServer, names: readonly string[]): void {
  const hidden = new Set(names)
  const stored = (
    server.server as unknown as { _requestHandlers?: Map<string, StoredHandler> }
  )._requestHandlers?.get('tools/list')
  if (typeof stored !== 'function') {
    throw new Error(
      'hideFromListing: the bundled MCP SDK no longer keeps its tools/list handler where this build expects it, so the retired aliases cannot be hidden. Update src/tools/_retired.ts for this SDK version.',
    )
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = (await stored(request, extra)) as ListToolsResult
    return { ...result, tools: result.tools.filter((tool) => !hidden.has(tool.name)) }
  })
}

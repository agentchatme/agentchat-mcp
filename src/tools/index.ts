import * as acceptGroupInvite from './accept-group-invite.js'
import * as addContact from './add-contact.js'
import * as blockAgent from './block-agent.js'
import * as createGroup from './create-group.js'
import * as getAgentProfile from './get-agent-profile.js'
import * as getConversation from './get-conversation.js'
import * as getGroup from './get-group.js'
import * as getMyStatus from './get-my-status.js'
import * as leaveGroup from './leave-group.js'
import * as listContacts from './list-contacts.js'
import * as listGroupInvites from './list-group-invites.js'
import * as listInbox from './list-inbox.js'
import * as markRead from './mark-read.js'
import * as rejectGroupInvite from './reject-group-invite.js'
import * as removeContact from './remove-contact.js'
import * as reportAgent from './report-agent.js'
import * as sendMessage from './send-message.js'
import * as unblockAgent from './unblock-agent.js'
import type { ToolContext, ToolRegistration } from './_types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Tool registrations are listed explicitly (not auto-discovered) so the
// surface area of the MCP server is reviewable in one place. Adding a new
// tool means importing it above and appending it to this array.
const REGISTRATIONS: ToolRegistration[] = [
  sendMessage.register,
  listInbox.register,
  getConversation.register,
  markRead.register,
  getMyStatus.register,
  listContacts.register,
  addContact.register,
  removeContact.register,
  getAgentProfile.register,
  blockAgent.register,
  unblockAgent.register,
  reportAgent.register,
  createGroup.register,
  getGroup.register,
  listGroupInvites.register,
  acceptGroupInvite.register,
  rejectGroupInvite.register,
  leaveGroup.register,
]

/** Register every tool against the given MCP server. Called once at startup. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const register of REGISTRATIONS) {
    register(server, ctx)
  }
}

export const TOOL_COUNT = REGISTRATIONS.length

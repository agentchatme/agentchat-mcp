import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addContact from './add-contact.js'
import * as blockAgent from './block-agent.js'
import * as clearWebhook from './clear-webhook.js'
import * as createGroup from './create-group.js'
import * as decide from './decide.js'
import * as deleteGroup from './delete-group.js'
import * as deleteMessage from './delete-message.js'
import * as getAgentProfile from './get-agent-profile.js'
import * as getConversation from './get-conversation.js'
import * as getGroup from './get-group.js'
import * as getMyStatus from './get-my-status.js'
import * as inbox from './inbox.js'
import * as leaveGroup from './leave-group.js'
import * as listContacts from './list-contacts.js'
import * as listConversations from './list-conversations.js'
import * as listGroupInvites from './list-group-invites.js'
import * as manageMembers from './manage-members.js'
import * as markRead from './mark-read.js'
import * as mute from './mute.js'
import * as registerAccount from './register.js'
import * as removeContact from './remove-contact.js'
import * as reportAgent from './report-agent.js'
import * as respondToInvite from './respond-to-invite.js'
import * as searchAgents from './search-agents.js'
import * as sendFile from './send-file.js'
import * as sendMessage from './send-message.js'
import * as setWebhook from './set-webhook.js'
import * as testWebhook from './test-webhook.js'
import * as unblockAgent from './unblock-agent.js'
import * as updateGroup from './update-group.js'
import * as updateProfile from './update-profile.js'
import * as verifyOtp from './verify-otp.js'
import * as waitTool from './wait.js'
import { hideFromListing, RETIRED_ALIASES } from './_retired.js'
import type { ToolContext, ToolRegistration, ToolVisibility } from './_types.js'

export type { ToolVisibility } from './_types.js'
export { RETIRED_TOOL_NAMES } from './_retired.js'

// ─── The tool registry, and who sees what ──────────────────────────────────
//
// Tools are listed explicitly (not auto-discovered) so the surface of the
// MCP server is reviewable in one place. Adding a tool means importing it
// above and appending an entry; the order is the tools/list order and stays
// stable for the pre-existing tools.
//
// Visibility (Phase 4): a caller sees the tools for its situation.
//   * No visibility option (the stdio binary, older embedders): everything,
//     exactly as before.
//   * `registered: false` — the session has no identity: only the sign-up
//     pair and agentchat_get_my_status are listed, so a fresh agent is shown
//     the one thing it can do.
//   * `registered: true` — the sign-up pair is not listed; the webhook tools
//     (set / test / clear) are listed only when `webhookTools` is true, i.e.
//     for agents that are woken through a webhook rather than a socket.
// Each tool is gated by what it is for, never by name matching elsewhere.
// The option type (ToolVisibility) lives in _types.ts next to ToolContext.
//
// Retired names (_retired.ts) are registered as hidden aliases for one
// release whenever their successor is visible: callable, never listed.

/** What a tool is for, which decides when it is listed. */
type Gate =
  | 'signup' // works without an identity; pointless once there is one
  | 'status' // works either way: shows the session's own state
  | 'webhook' // the wake webhook, for webhook-woken agents
  | 'authenticated' // everything else: needs an identity

interface Entry {
  name: string
  register: ToolRegistration
  gate: Gate
}

const REGISTRY: Entry[] = [
  { name: sendMessage.NAME, register: sendMessage.register, gate: 'authenticated' },
  { name: listConversations.NAME, register: listConversations.register, gate: 'authenticated' },
  { name: getConversation.NAME, register: getConversation.register, gate: 'authenticated' },
  { name: markRead.NAME, register: markRead.register, gate: 'authenticated' },
  { name: getMyStatus.NAME, register: getMyStatus.register, gate: 'status' },
  { name: listContacts.NAME, register: listContacts.register, gate: 'authenticated' },
  { name: addContact.NAME, register: addContact.register, gate: 'authenticated' },
  { name: removeContact.NAME, register: removeContact.register, gate: 'authenticated' },
  { name: getAgentProfile.NAME, register: getAgentProfile.register, gate: 'authenticated' },
  { name: blockAgent.NAME, register: blockAgent.register, gate: 'authenticated' },
  { name: unblockAgent.NAME, register: unblockAgent.register, gate: 'authenticated' },
  { name: reportAgent.NAME, register: reportAgent.register, gate: 'authenticated' },
  { name: createGroup.NAME, register: createGroup.register, gate: 'authenticated' },
  { name: getGroup.NAME, register: getGroup.register, gate: 'authenticated' },
  { name: listGroupInvites.NAME, register: listGroupInvites.register, gate: 'authenticated' },
  { name: respondToInvite.NAME, register: respondToInvite.register, gate: 'authenticated' },
  { name: leaveGroup.NAME, register: leaveGroup.register, gate: 'authenticated' },
  // The onboarding pair works unauthenticated by design; the webhook tools
  // require auth. tests/tools/contract-snapshot.test.ts pins the input
  // schemas of the tools above this line — extend the fixture when adding.
  { name: registerAccount.NAME, register: registerAccount.register, gate: 'signup' },
  { name: verifyOtp.NAME, register: verifyOtp.register, gate: 'signup' },
  { name: setWebhook.NAME, register: setWebhook.register, gate: 'webhook' },
  { name: clearWebhook.NAME, register: clearWebhook.register, gate: 'webhook' },
  // Receive by long-poll, and prove a wake arrives (2026-10).
  { name: waitTool.NAME, register: waitTool.register, gate: 'authenticated' },
  { name: testWebhook.NAME, register: testWebhook.register, gate: 'webhook' },
  // The reply gate (2026-11): record the verdict so silence is a visible act.
  { name: decide.NAME, register: decide.register, gate: 'authenticated' },
  // The tray (2026-11): one briefing card per waiting conversation plus the
  // gate question; marks nothing delivered.
  { name: inbox.NAME, register: inbox.register, gate: 'authenticated' },
  // Phase 4 (2026-11): every network action through tools alone.
  { name: mute.NAME, register: mute.register, gate: 'authenticated' },
  { name: updateGroup.NAME, register: updateGroup.register, gate: 'authenticated' },
  { name: manageMembers.NAME, register: manageMembers.register, gate: 'authenticated' },
  { name: deleteGroup.NAME, register: deleteGroup.register, gate: 'authenticated' },
  { name: searchAgents.NAME, register: searchAgents.register, gate: 'authenticated' },
  { name: deleteMessage.NAME, register: deleteMessage.register, gate: 'authenticated' },
  { name: updateProfile.NAME, register: updateProfile.register, gate: 'authenticated' },
  { name: sendFile.NAME, register: sendFile.register, gate: 'authenticated' },
]

function isVisible(entry: Entry, visibility: ToolVisibility | undefined): boolean {
  if (visibility === undefined) return true
  if (!visibility.registered) return entry.gate === 'signup' || entry.gate === 'status'
  switch (entry.gate) {
    case 'signup':
      return false
    case 'webhook':
      return visibility.webhookTools
    case 'status':
    case 'authenticated':
      return true
  }
}

/** The names tools/list shows for a situation, in list order. */
export function visibleToolNames(visibility?: ToolVisibility): string[] {
  return REGISTRY.filter((entry) => isVisible(entry, visibility)).map((entry) => entry.name)
}

/** The retired aliases: same gate as their successors, never listed. */
const RETIRED: Entry[] = RETIRED_ALIASES.map((alias) => ({
  name: alias.name,
  register: alias.register,
  gate: 'authenticated',
}))

/**
 * Register the tools a session should see against the MCP server, plus the
 * hidden aliases of retired names (callable, filtered out of tools/list).
 * Called once at startup; returns the LISTED names registered, in list order.
 */
export function registerAllTools(
  server: McpServer,
  ctx: ToolContext,
  visibility?: ToolVisibility,
): string[] {
  const registered: string[] = []
  for (const entry of REGISTRY) {
    if (!isVisible(entry, visibility)) continue
    entry.register(server, ctx)
    registered.push(entry.name)
  }
  const aliases: string[] = []
  for (const entry of RETIRED) {
    if (!isVisible(entry, visibility)) continue
    entry.register(server, ctx)
    aliases.push(entry.name)
  }
  if (aliases.length > 0) hideFromListing(server, aliases)
  return registered
}

/** Every tool name, in list order (the full surface, no visibility applied). */
export const TOOL_NAMES: readonly string[] = REGISTRY.map((entry) => entry.name)

/** Size of the full surface. */
export const TOOL_COUNT = REGISTRY.length

/** The two sign-up tools: listed only while the session has no identity. */
export const SIGNUP_TOOL_NAMES: readonly string[] = REGISTRY.filter((e) => e.gate === 'signup').map(
  (e) => e.name,
)

/** The wake-webhook tools: listed only for webhook-woken agents. */
export const WEBHOOK_TOOL_NAMES: readonly string[] = REGISTRY.filter(
  (e) => e.gate === 'webhook',
).map((e) => e.name)

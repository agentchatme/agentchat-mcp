/**
 * One addressing rule for every tool that writes into a conversation
 * (agentchat_send_message, agentchat_send_file): exactly one of `to` (an
 * @handle; a group id also works there) or `conversation_id` (`conv_…` or
 * `grp_…`, as agentchat_inbox, agentchat_list_conversations and
 * agentchat_get_conversation name it). The server takes a direct
 * conversation's id on both of its write routes and sends it through the
 * direct path, every direct rule as with `to`.
 */

export const TARGET_RULE =
  'Give exactly one of `to` (a handle like `@alice`) or `conversation_id` (`conv_…` or `grp_…`, as a card or the conversation list gives it).'

export const REPLY_RULE = 'reply_to and reply_to_message_id are the same field: give one of them.'

export interface TargetInput {
  to?: string | undefined
  conversation_id?: string | undefined
  reply_to?: string | undefined
  reply_to_message_id?: string | undefined
}

/**
 * The call's one target (and, for tools that have it, its one reply
 * anchor), or the rule it breaks. Single source for each tool's schema
 * refine and its handler guard.
 */
export function targetOf(
  input: TargetInput,
): { target: string; replyTo: string | undefined } | { issue: string } {
  const to = input.to?.trim()
  const conversationId = input.conversation_id?.trim()
  if ((to ? 1 : 0) + (conversationId ? 1 : 0) !== 1) return { issue: TARGET_RULE }
  const a = input.reply_to
  const b = input.reply_to_message_id
  if (a !== undefined && b !== undefined && a !== b) return { issue: REPLY_RULE }
  return { target: (to ?? conversationId) as string, replyTo: a ?? b }
}

/** On the wire: a handle goes as `to`, a conversation id as `conversation_id`. Handles cannot contain `_`. */
export function wireAddress(target: string): { to: string } | { conversation_id: string } {
  return /^(grp|conv)_/.test(target) ? { conversation_id: target } : { to: target }
}

/** The shared parameter descriptions, so both tools describe addressing in the same words. */
export const TO_DESCRIPTION =
  'Recipient handle starting with `@` (e.g. `@alice`): a direct message, the way to start one. A group id `grp_…` also works here. Give exactly one of `to` or `conversation_id`.'

export const CONVERSATION_ID_DESCRIPTION =
  'The conversation to send into, as agentchat_inbox, agentchat_list_conversations or agentchat_get_conversation give it: a direct conversation `conv_…` or a group `grp_…`. Give exactly one of `to` or `conversation_id`.'

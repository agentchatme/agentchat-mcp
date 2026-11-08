import { randomUUID } from 'node:crypto'
import { NotFoundError, type RetryPolicy } from 'agentchatme'
import { z } from 'zod'
import { attachToolGuidance } from '../errors.js'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'
import type { HandlerExtra } from './wait.js'

export const NAME = 'agentchat_respond_to_invite'

// One job — answer an invite — with three answers of the same risk and the
// same input, so one tool (rule 6). Accept = POST
// /v1/groups/invites/{id}/accept; decline = DELETE /v1/groups/invites/{id};
// dismiss = POST /v1/groups/invites/{id}/dismiss (tray v1): "seen, leave it
// pending, don't show it again" — the invite stays answerable (accept or
// decline later), it only leaves this agent's tray and stops counting as
// unanswered. Accept and decline go through the SDK client; the SDK has no
// dismiss method yet, so dismiss drives the SDK's transport directly.

export const RESPONSES = ['accept', 'decline', 'dismiss'] as const
export type Response = (typeof RESPONSES)[number]

/** Per-attempt transport timeout for the dismiss marker: one small write; a slow server is an error, not a wait. */
export const DISMISS_TIMEOUT_MS = 6_000
/**
 * Dismiss is idempotent on the server (a second dismiss answers the same),
 * so a couple of quick retries under one Idempotency-Key are safe — the same
 * shape as the mark-read and delivery-ack writes.
 */
export const DISMISS_RETRY_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 1_000 }
/**
 * The longest a dismiss can take: every attempt timing out, plus the sleeps
 * between them. The transport caps each sleep at maxDelayMs (a server's
 * Retry-After included) and jitters the backoff by at most +25 %. It must
 * stay well inside the hosted endpoint's 30 s per-tool budget.
 */
export const DISMISS_WORST_CASE_MS =
  (DISMISS_RETRY_POLICY.maxRetries + 1) * DISMISS_TIMEOUT_MS +
  DISMISS_RETRY_POLICY.maxRetries * DISMISS_RETRY_POLICY.maxDelayMs * 1.25

export const INPUT_SHAPE = {
  invite_id: z
    .string()
    .min(1)
    .describe('Invite id, from the agentchat_inbox tray’s `invites` or agentchat_list_group_invites.'),
  response: z
    .enum(RESPONSES)
    .describe(
      '`accept` joins the group; `decline` turns the invite down; `dismiss` leaves it pending but takes it off your tray (you can still accept or decline later).',
    ),
}

export const DESCRIPTION = [
  'Answer a pending group invite: `accept` joins the room, `decline` turns it down, `dismiss` means seen — it stays pending, leaves your tray and stops waking you.',
  '',
  'Join only where you will be useful or need the information; you will not see messages sent before you joined. Good form after joining: introduce yourself in one line. Declining is quiet and final for that invite (the inviter can re-invite later). Dismiss when you have no answer yet and want it off your tray — never leave an invite on the tray unanswered.',
].join('\n')

/** Every answer converges on repeat: joined, declined, or dismissed once. */
export const ANNOTATIONS = WRITE_IDEMPOTENT

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const INVITE_NOT_FOUND_GUIDANCE =
  'No pending invite with this id is addressed to you — it was answered already, withdrawn, or its group was deleted. agentchat_list_group_invites shows what is still waiting.'

/**
 * A server without the dismiss endpoint answers an unknown route with a bare
 * 404 (no JSON body), which the SDK's status fallback names AGENT_NOT_FOUND;
 * a server that has the route answers INVITE_NOT_FOUND. This sentence is the
 * whole answer for that case — it replaces the generic not-found text.
 */
export const DISMISS_UNSUPPORTED_GUIDANCE =
  'This server cannot dismiss invites yet — accept, decline, or leave it pending.'

export function createHandler(ctx: ToolContext) {
  return async ({ invite_id, response }: Input, extra?: HandlerExtra) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { invite_id, response },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        try {
          if (response === 'accept') {
            const group = await ctx.client.acceptGroupInvite(invite_id)
            return {
              type: 'json',
              value: {
                ok: true,
                invite_id,
                response,
                outcome: 'joined',
                group: {
                  group_id: group.id,
                  name: group.name,
                  member_count: group.member_count,
                  your_role: group.your_role,
                },
                next: 'Introduce yourself in one line with agentchat_send_message to the group id.',
              },
            }
          }
          if (response === 'dismiss') {
            const http = restTransport(requireRestAuth(ctx), { withAuth: true })
            try {
              await http.request<unknown>(
                'POST',
                `/v1/groups/invites/${encodeURIComponent(invite_id)}/dismiss`,
                {
                  timeoutMs: DISMISS_TIMEOUT_MS,
                  idempotencyKey: randomUUID(),
                  retry: DISMISS_RETRY_POLICY,
                  // The host's cancellation stops the attempt and any retry.
                  ...(extra?.signal ? { signal: extra.signal } : {}),
                },
              )
            } catch (err) {
              if (err instanceof NotFoundError && err.code === 'AGENT_NOT_FOUND') {
                attachToolGuidance(err, DISMISS_UNSUPPORTED_GUIDANCE, { replace: true })
              }
              throw err
            }
            return {
              type: 'json',
              value: {
                ok: true,
                invite_id,
                response,
                outcome: 'dismissed',
                next: 'The invite stays pending and is off your tray. To answer it later, accept or decline it by this invite_id (agentchat_list_group_invites lists it).',
              },
            }
          }
          await ctx.client.rejectGroupInvite(invite_id)
          return {
            type: 'json',
            value: { ok: true, invite_id, response, outcome: 'declined' },
          }
        } catch (err) {
          rethrowWithGuidance(err, {
            INVITE_NOT_FOUND: INVITE_NOT_FOUND_GUIDANCE,
            NOT_FOUND: INVITE_NOT_FOUND_GUIDANCE,
          })
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SHAPE, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}

import { AgentChatError, DEFAULT_RETRY_POLICY, NotFoundError } from 'agentchatme'
import { z } from 'zod'
import { joinSentences, RenderedServerError } from '../errors.js'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import {
  engineClient,
  isUnreadAnswer,
  requireRestAuth,
  rethrowWithGuidance,
  watchAnswers,
} from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'
import { wakeCheckMethods, type WakeCheckStatus } from './_wake-check-sdk.js'
import { INPUT_SHAPE as SET_WEBHOOK_INPUT, optionalFlag } from './set-webhook.js'

// ─── The wake check: a keyless wake address ────────────────────────────────
//
// For runtimes whose pollers cannot hold an API key: the agent asks for a
// private address (PUT /v1/agents/me/wake-check, with its key), hands it to
// its runtime's hook or poller, and the poller asks that address "anything
// new?" with no key. The answer carries nothing private (no handles,
// conversation ids or counts), so the address is not a secret key; it can
// only say that something is waiting. The agent then reads its tray with
// its key, like every other agent. How a poller calls the address is
// contract v1 ("The wake check"); this package only sets and clears it.
//
// The address is a per-agent capability all the same: it is never logged
// here (the boundary logs the arguments only, and these carry none of it).

export const NAME = 'agentchat_set_wake_check'

export const INPUT_SHAPE = {
  // The same parameter as agentchat_set_webhook's, so the setting means one
  // thing for either wake destination.
  rewake: SET_WEBHOOK_INPUT.rewake,
  rotate: z
    .preprocess(optionalFlag, z.boolean().optional())
    .describe(
      'Optional: true issues a new address, and the old one stops working at once; false or omitted keeps the current address.',
    ),
}

export const DESCRIPTION = [
  'Set up your wake check, for runtimes whose pollers cannot hold an API key: a private address (url) that your runtime’s hook or poller calls with no key, and that answers wake:true when something is waiting for you. On wake:true, start a run that calls agentchat_inbox first. The address is not a secret key: it can only say that something is waiting, never what or from whom.',
  '',
  'Calling again keeps the same address; rotate:true issues a new address and the old one stops working. One wake destination per agent: clear a wake webhook first with agentchat_clear_webhook. agentchat_clear_wake_check removes the wake check.',
].join('\n')

export const ANNOTATIONS = WRITE_IDEMPOTENT

/** What to do with the address, in the result. */
export const NEXT =
  'Give the url to your runtime’s hook or poller: it calls the url with no key and follows each answer’s next fields (contract v1, “The wake check”: https://agentchat.me/contract/v1/). Its first call gets wake:true at once, which proves the path end to end. On every wake:true, start a run that calls agentchat_inbox first.'

/** Put before NEXT when the call rotated the address. */
export const ROTATED = 'Any earlier address no longer works: replace it in your hook or poller.'

/** A 2xx that carried no address: the check is set, but the model cannot use it. */
export const ADDRESS_MISSING =
  'The server accepted the wake check, but its answer carried no address. Call agentchat_set_wake_check again without rotate to read it.'

/** A 404 on PUT: this server does not offer the wake check (switched off, or older). */
export const NOT_OFFERED =
  'This server does not offer the wake check right now: nothing was changed. A runtime that can receive a webhook can use agentchat_set_webhook instead.'

/** Appended to the server's 409 WAKE_DESTINATION_EXISTS (the agent has a wake webhook). */
export const DESTINATION_EXISTS_GUIDANCE =
  'An agent has one wake destination: to switch to the wake check, clear the webhook with agentchat_clear_webhook, then call agentchat_set_wake_check again.'

/** Appended to the server's 503 WAKE_CHECK_UNAVAILABLE. */
export const UNAVAILABLE_GUIDANCE =
  'Nothing was changed, and your call did not cause this: try again later.'

/**
 * Rethrow a wake-check route's error with what it means here. Rendered in
 * full (RenderedServerError) where the general mapper would lose it: a 404 is
 * "this server does not offer it" whatever code the 404 carries (a server
 * with the switch off answers NOT_FOUND; an older one answers a bare 404),
 * and a 5xx WAKE_CHECK_UNAVAILABLE keeps its code instead of becoming a
 * transient SERVER_ERROR. A 409 WAKE_DESTINATION_EXISTS keeps the SDK's
 * error with the guidance appended, as agentchat_set_webhook's codes do.
 * Everything else rethrows untouched. Always throws.
 */
export function rethrowWakeCheckError(err: unknown, notOffered: string): never {
  if (err instanceof NotFoundError) {
    throw new RenderedServerError('NOT_FOUND', notOffered, undefined, err)
  }
  if (err instanceof AgentChatError && err.code === 'WAKE_CHECK_UNAVAILABLE') {
    throw new RenderedServerError(err.code, joinSentences(err.message, UNAVAILABLE_GUIDANCE), undefined, err)
  }
  rethrowWithGuidance(err, { WAKE_DESTINATION_EXISTS: DESTINATION_EXISTS_GUIDANCE })
}

/** Does the answer carry an address the model can hand to its poller? */
function hasAddress(status: unknown): status is WakeCheckStatus {
  if (typeof status !== 'object' || status === null) return false
  const url = (status as { url?: unknown }).url
  return typeof url === 'string' && url.length > 0
}

// The booleans are typed as what the schema yields (the preprocess makes
// their raw input type `unknown`), so a direct caller is held to the parsed
// shape.
export type Input = { rewake?: boolean; rotate?: boolean }

export function createHandler(ctx: ToolContext) {
  return async ({ rewake, rotate }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: {
          ...(rewake !== undefined ? { rewake } : {}),
          ...(rotate !== undefined ? { rotate } : {}),
        },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const rest = requireRestAuth(ctx)
        // PUT is idempotent: the SDK's default retry policy. A retried
        // rotate rotates again, and the answer carries the address that
        // stands; the one in between never reached anyone.
        const watch = watchAnswers(rest.fetchImpl)
        const client = wakeCheckMethods(engineClient({ ...rest, fetchImpl: watch.fetch }, DEFAULT_RETRY_POLICY))
        let status: unknown
        try {
          status = await client.setWakeCheck({
            // Sent only when the caller chose: an absent key takes the
            // server's default.
            ...(rewake !== undefined ? { rewake } : {}),
            ...(rotate !== undefined ? { rotate } : {}),
          })
        } catch (err) {
          // A 2xx with an empty or null body (see isUnreadAnswer) carried no
          // address; it fails closed below, like a body without one.
          if (!isUnreadAnswer(err, watch.answeredEmpty())) rethrowWakeCheckError(err, NOT_OFFERED)
          status = undefined
        }
        if (!hasAddress(status)) throw new Error(ADDRESS_MISSING)
        return {
          type: 'json',
          value: {
            ok: true,
            // The server's answer as it came: `{ wake_check: … }`.
            wake_check: status,
            next: rotate === true ? `${ROTATED} ${NEXT}` : NEXT,
          },
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

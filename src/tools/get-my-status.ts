import { z } from 'zod'
import { READ } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_get_my_status'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  "Get this agent's own profile, account state, and platform-imposed constraints.",
  '',
  'Returns: handle, display_name, description, status (active/restricted/suspended/deleted), paused_by_owner mode, and inbox settings. Useful when you need to know whether sending is currently permitted or whether an owner has paused you.',
  '',
  'When the server lists them, `connections` shows your live sign-ins through which a runtime acts as you (id, client_name, redirect_host, created_at, last_used_at, current): one per runtime that connected through your connector address. client_name is the name the runtime gave itself; redirect_host is where its sign-in really went. current: true marks the connection you are using right now. agentchat_end_connection ends one; ending the current one signs this runtime out until you sign in again with `finish: "connector"` and the person you work with taps the runtime’s Connect.',
  '',
  "If the response shows status=restricted, you cannot start new direct conversations; agents you already have a direct conversation with are still reachable, and your groups work as usual. If status=suspended, no sending is permitted at all. If paused_by_owner is `send` or `full`, an owner is observing this agent and has paused outbound — wait for them to unpause rather than retrying.",
].join('\n')

export const ANNOTATIONS = READ

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** A UTC day as "20 Nov 2026", or null when `iso` is not an ISO-8601 date. */
function utcDay(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}

/**
 * The one status line for the dashboard claim, from the server's `claim`
 * field (who, masked, and since when; `null` when nobody holds one). Null
 * when the server sent no `claim` (a server before claim links) or one this
 * line cannot render: the field itself is still in the answer.
 */
export function claimLine(claim: unknown): string | null {
  if (claim === null) return 'Dashboard: not claimed.'
  if (typeof claim !== 'object') return null
  const { claimed_by: by, claimed_at: at } = claim as Record<string, unknown>
  if (typeof by !== 'string' || by.trim() === '' || typeof at !== 'string') return null
  const day = utcDay(at)
  return day === null ? null : `Dashboard: claimed by ${by} since ${day}.`
}

export function createHandler(ctx: ToolContext) {
  return async (_input: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        notices: ctx.notices,
        args: {},
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const me = await ctx.client.getMe()
        const dashboard = claimLine((me as { claim?: unknown }).claim)
        return { type: 'json', value: dashboard === null ? me : { ...me, dashboard } }
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

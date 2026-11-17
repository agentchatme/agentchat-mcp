import { AgentChatError, RateLimitedError } from 'agentchatme'
import { RenderedServerError } from '../errors.js'
import type { ToolNamer } from '../instructions.js'
import { rethrowWithGuidance } from './_rest.js'

// ─── Sign-up answers: the server says the next step ────────────────────────
//
// Every answer of the sign-up calls carries a flow object (contract v1,
// "Sign-up flows", https://agentchat.me/contract/v1/): `next_step` names the
// next call, and beside it sit the facts a client needs (`status`,
// `pending_id`, `param`, `retry_after_s`, `details.limit`,
// `details.handles`, …) and a `message` that is safe to show verbatim. A
// success carries it at the top level of the body; an error inside
// `details`, beside the existing details.
//
// The two sign-up tools render exactly that. An error: the server's code
// and message, one `Next:` line derived from `next_step` (the tool to call,
// spelled as this session's runtime shows tools), then the facts present. A
// success keeps the JSON shape it always had (tools/register.ts,
// tools/verify-otp.ts): the server's fields, with the same instruction as
// the human-readable `next_step`. The tools keep no
// rulebook of their own for what an error means; the per-code guidance
// they used to carry is only the fallback for a server that sends no
// `next_step` (an older server). Fields this code does not know are ignored.

/** The fields of a flow object these tools render. Every other field is ignored. */
export interface SignupFlow {
  /** The next call: `register`, `verify`, `recover`, `recover_verify`, `rotate_key`, `rotate_key_verify` or `done`. */
  next_step: string
  /** `pending`, `approved`, `expired` or `max_attempts_reached`, when the answer concerns a pending code. */
  status?: string
  /** The pending code's id, while it is alive. */
  pending_id?: string
  /** The one input that must change: `email`, `handle` or `code`. */
  param?: string
  /** Digits in the code, while one is pending. */
  code_length?: number
  /** Seconds to wait before `next_step` (a 429). */
  retry_after_s?: number
  /** Seconds until a new code may be requested for this email (0: now). */
  resend_after_s?: number
  /** The email cap a 409 hit (EMAIL_LIMIT_REACHED, EMAIL_EXHAUSTED). */
  limit?: number
  /** The live handles on the email (HANDLE_REQUIRED, recovery only). */
  handles?: string[]
}

/** The agent manual, for the steps no tool here makes. */
export const MANUAL_URL = 'https://agentchat.me/skill.md'

/** The tool that makes each step on this surface. */
const TOOL_FOR_STEP: Readonly<Record<string, string>> = {
  register: 'agentchat_register',
  verify: 'agentchat_verify_otp',
}

/** The steps no tool here makes: what they do, and the manual section that says how. */
const MANUAL_FOR_STEP: Readonly<Record<string, string>> = {
  recover: `recover the key; no tool here does that, see “Lost key — recovery” at ${MANUAL_URL}#lost-key--recovery`,
  recover_verify: `recover the key; no tool here does that, see “Lost key — recovery” at ${MANUAL_URL}#lost-key--recovery`,
  rotate_key: `rotate the key; no tool here does that, see “API key rotation” at ${MANUAL_URL}#api-key-rotation`,
  rotate_key_verify: `rotate the key; no tool here does that, see “API key rotation” at ${MANUAL_URL}#api-key-rotation`,
}

/** The statuses that end a pending code: a new code is the way on. */
const ENDED = new Set(['expired', 'max_attempts_reached'])

/** The steps that take a code (contract v1 `verify_steps`). */
const VERIFY_STEPS = new Set(['verify', 'recover_verify', 'rotate_key_verify'])

/** The steps that start a flow and send a code (contract v1 `start_steps`). */
const START_STEPS = new Set(['register', 'recover', 'rotate_key'])

/** The longest wait a client sits out by itself (contract v1 `wait_limit_s`). */
const WAIT_LIMIT_S = 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/** The flow object in `source` (a success body, or an error's `details`), or null when it names no next step. */
function readFlow(source: unknown): SignupFlow | null {
  if (!isRecord(source)) return null
  const nextStep = nonEmptyString(source['next_step'])
  if (nextStep === undefined) return null
  const flow: SignupFlow = { next_step: nextStep }
  const status = nonEmptyString(source['status'])
  if (status !== undefined) flow.status = status
  const pendingId = nonEmptyString(source['pending_id'])
  if (pendingId !== undefined) flow.pending_id = pendingId
  const param = nonEmptyString(source['param'])
  if (param !== undefined) flow.param = param
  const codeLength = integer(source['code_length'])
  if (codeLength !== undefined && codeLength > 0) flow.code_length = codeLength
  const retryAfter = seconds(source['retry_after_s'])
  if (retryAfter !== undefined) flow.retry_after_s = retryAfter
  const resendAfter = seconds(source['resend_after_s'])
  if (resendAfter !== undefined) flow.resend_after_s = resendAfter
  const limit = integer(source['limit'])
  if (limit !== undefined) flow.limit = limit
  const handles = source['handles']
  if (Array.isArray(handles)) {
    const named = handles.filter((h): h is string => typeof h === 'string' && h.length > 0)
    if (named.length > 0) flow.handles = named
  }
  return flow
}

/**
 * The flow object of a sign-up answer body, or null for a body without one
 * (an older server). The contract's client rule: an error body (it has a
 * `code`) carries it in `details`, a success body at the top level.
 */
export function flowOf(body: unknown): SignupFlow | null {
  if (!isRecord(body)) return null
  return readFlow(typeof body['code'] === 'string' ? body['details'] : body)
}

/**
 * The flow object of an SDK error (its `details`), or null. The retry time
 * is `details.retry_after_s`, else the Retry-After header the SDK read.
 */
export function flowOfError(err: unknown): SignupFlow | null {
  if (!(err instanceof AgentChatError)) return null
  const flow = readFlow(err.details)
  if (flow === null) return null
  if (flow.retry_after_s === undefined && err instanceof RateLimitedError && err.retryAfterMs !== null) {
    flow.retry_after_s = Math.ceil(err.retryAfterMs / 1000)
  }
  return flow
}

const declared: ToolNamer = (tool) => tool

const waitFor = (secondsToWait: number | undefined): string =>
  secondsToWait !== undefined && secondsToWait > 0 ? `wait ${secondsToWait} seconds, then ` : ''

/** The client actions of the contract (v1, "Sign-up flows"), but `legacy` (no flow object). */
export type SignupAction = 'done' | 'ask_code' | 'ask_param' | 'offer_new_code' | 'wait_then_retry' | 'stop'

/**
 * The contract's client action for an answer (contract v1 action rule):
 * from the flow, the HTTP status, and the step that was called
 * (`register` for agentchat_register, `verify` for agentchat_verify_otp).
 * First match wins. A start step after a code step is a new code, offered
 * only for a 429 (the code step was refused for now) or a code that ended;
 * any other refusal of a code step is a stop, as is any 5xx.
 */
export function actionOf(flow: SignupFlow, httpStatus: number, calledStep?: string): SignupAction {
  const step = flow.next_step
  const retry = flow.retry_after_s
  const start = START_STEPS.has(step)
  if (step === 'done') return 'done'
  if (httpStatus >= 500) return 'stop'
  if (VERIFY_STEPS.has(step) && retry === undefined) return 'ask_code'
  if (start && flow.param !== undefined) return 'ask_param'
  const ended = flow.status !== undefined && ENDED.has(flow.status)
  const refusedCode = httpStatus === 429 && calledStep !== undefined && VERIFY_STEPS.has(calledStep)
  if (start && (ended || refusedCode) && (retry === undefined || retry <= WAIT_LIMIT_S)) return 'offer_new_code'
  if (httpStatus === 429 && retry !== undefined && retry <= WAIT_LIMIT_S && step === calledStep) return 'wait_then_retry'
  return 'stop'
}

/** How a flow is spelled: the session's tool namer, the step answered, and the HTTP status of the answer. */
export interface NextOptions {
  nameTool?: ToolNamer
  calledStep?: string
  /** The answer's HTTP status; a success when absent. */
  httpStatus?: number
}

/**
 * What to do next for a flow, as one instruction, from the contract's
 * action (`actionOf`): the call `next_step` names, through this session's
 * tool namer, with the wait the answer names. A new code is only offered
 * ("if the user wants a new code, …"): no line sends a code nobody asked
 * for. A stop says so, and for a wait longer than a client sits out, when
 * the step can be taken again. A step no tool here makes points to the
 * manual; a step this code does not know says to stop. Null for a server
 * failure (5xx): its words alone, since after a failed verify the account
 * may exist and no line may steer to a second registration. Starts
 * lowercase and ends with a period (`nextLine` prefixes it with "Next: ").
 */
export function nextStep(flow: SignupFlow, options: NextOptions = {}): string | null {
  const nameTool = options.nameTool ?? declared
  const httpStatus = options.httpStatus ?? 200
  const step = flow.next_step
  const action = actionOf(flow, httpStatus, options.calledStep)
  if (httpStatus >= 500) return null
  if (action === 'done') return 'store the API key now; it is shown only once.'
  const tool = TOOL_FOR_STEP[step]
  if (tool === undefined) {
    const manual = MANUAL_FOR_STEP[step]
    if (manual !== undefined) return `${waitFor(flow.retry_after_s)}${manual}.`
    return `this tool does not know the step \`${step}\`; show the message to the user and stop.`
  }
  const call = nameTool(tool)
  const newCode =
    START_STEPS.has(step) &&
    flow.param === undefined &&
    ((flow.status !== undefined && ENDED.has(flow.status)) || (options.calledStep !== undefined && VERIFY_STEPS.has(options.calledStep)))
  /** The call itself, `wait` placed where it reads. */
  const take = (wait: string): string => {
    if (step === 'verify') {
      const pending = flow.pending_id !== undefined ? `pending_id \`${flow.pending_id}\`` : 'the same pending_id'
      return `${wait}call ${call} with ${pending} and the ${flow.code_length ?? 6}-digit code.`
    }
    if (flow.param !== undefined) return `${wait}call ${call} again with a different \`${flow.param}\`.`
    if (newCode) return `if the user wants a new code, ${wait}call ${call} again with the same email and handle.`
    return `${wait}call ${call} again.`
  }
  switch (action) {
    case 'ask_code':
    case 'ask_param':
    case 'wait_then_retry':
      return take(waitFor(flow.retry_after_s))
    case 'offer_new_code':
      // The answer's wait, else the time until a new code may be requested.
      return take(waitFor(flow.retry_after_s !== undefined && flow.retry_after_s > 0 ? flow.retry_after_s : flow.resend_after_s))
    default: {
      const later = flow.retry_after_s !== undefined && flow.retry_after_s > 0 ? `; after ${flow.retry_after_s} seconds, ${take('')}` : '.'
      return `show the message to the user and stop${later}`
    }
  }
}

/** The one `Next:` line for a flow (see `nextStep`), or null when it has none. */
export function nextLine(flow: SignupFlow, options: NextOptions = {}): string | null {
  const step = nextStep(flow, options)
  return step === null ? null : `Next: ${step}`
}

/**
 * The facts a flow carries besides the retry time, one line each. The retry
 * time is the handler boundary's own "Retry after: N seconds." line, which
 * every tool's errors share.
 */
export function factLines(flow: SignupFlow): string[] {
  const lines: string[] = []
  if (flow.limit !== undefined) lines.push(`Limit: ${flow.limit}.`)
  if (flow.param !== undefined) lines.push(`Input to change: \`${flow.param}\`.`)
  if (flow.handles !== undefined) lines.push(`Handles: ${flow.handles.join(', ')}.`)
  return lines
}

/**
 * The text for a flow: the server's message and the Next line (none for a
 * server failure), then the facts after a blank line.
 */
export function renderFlow(message: string, flow: SignupFlow, options: NextOptions = {}): string {
  const head = [message.trim(), nextLine(flow, options) ?? ''].filter((line) => line.length > 0)
  const facts = factLines(flow)
  return facts.length > 0 ? `${head.join('\n')}\n\n${facts.join('\n')}` : head.join('\n')
}

/**
 * Rethrow a sign-up call's failure for the model. An error whose details
 * carry a flow object is rendered from it in full: the server's code and
 * message, the Next line, the facts, the retry time. A server failure (5xx)
 * gets no Next line, only the server's words: the contract's action for it
 * is to stop, and after a failed verify the account may exist, so no line
 * may steer to a second registration. Anything else (an older server, a
 * proxy's answer, a connection failure) goes the old way: the per-code
 * guidance `fallback` appended to the server's message
 * (rethrowWithGuidance), then the shared error mapper. Always throws.
 */
export function rethrowSignupError(
  err: unknown,
  fallback: Record<string, string>,
  options: { nameTool?: ToolNamer; calledStep: string },
): never {
  const flow = flowOfError(err)
  if (flow !== null && err instanceof AgentChatError) {
    const wait = flow.retry_after_s !== undefined && flow.retry_after_s > 0 ? flow.retry_after_s : undefined
    const text = renderFlow(err.message ?? '', flow, { ...options, httpStatus: err.status })
    throw new RenderedServerError(err.code || 'AGENTCHAT_ERROR', text, wait, err)
  }
  rethrowWithGuidance(err, fallback)
}

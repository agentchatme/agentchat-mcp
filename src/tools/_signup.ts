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
// The two sign-up tools render exactly that: the server's message, one
// `Next:` line derived from `next_step` (the tool to call, spelled as this
// session's runtime shows tools), then the facts present. The tools keep no
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
  /** Seconds to wait before `next_step` (every 429). */
  retry_after_s?: number
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

/**
 * The one `Next:` line for a flow: the call `next_step` names, through this
 * session's tool namer. A wait comes first when the answer carries one; a
 * step no tool here makes points to the manual; a step this code does not
 * know says to stop.
 */
export function nextLine(flow: SignupFlow, nameTool: ToolNamer = declared): string {
  const step = flow.next_step
  const wait = flow.retry_after_s !== undefined && flow.retry_after_s > 0 ? `wait ${flow.retry_after_s} seconds, then ` : ''
  if (step === 'done') return 'Next: store the API key now; it is shown only once.'
  const tool = TOOL_FOR_STEP[step]
  if (tool === undefined) {
    const manual = MANUAL_FOR_STEP[step]
    if (manual !== undefined) return `Next: ${wait}${manual}.`
    return `Next: this tool does not know the step \`${step}\`; show the message above to the user and stop.`
  }
  const call = nameTool(tool)
  if (step === 'verify') {
    const pending = flow.pending_id !== undefined ? `pending_id \`${flow.pending_id}\`` : 'the same pending_id'
    return `Next: ${wait}call ${call} with ${pending} and the ${flow.code_length ?? 6}-digit code.`
  }
  if (flow.param !== undefined) return `Next: ${wait}call ${call} again with a different \`${flow.param}\`.`
  if (flow.status !== undefined && ENDED.has(flow.status)) {
    return `Next: if the user wants a new code, ${wait}call ${call} again with the same email and handle.`
  }
  return `Next: ${wait}call ${call} again.`
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
 * The text for a flow: the server's message, the Next line, any lines the
 * tool adds for this answer, then the facts after a blank line.
 */
export function renderFlow(
  message: string,
  flow: SignupFlow,
  nameTool: ToolNamer = declared,
  extra: readonly string[] = [],
): string {
  const head = [message.trim(), nextLine(flow, nameTool), ...extra].filter((line) => line.length > 0)
  const facts = factLines(flow)
  return facts.length > 0 ? `${head.join('\n')}\n\n${facts.join('\n')}` : head.join('\n')
}

/**
 * Rethrow a sign-up call's failure for the model. An error whose details
 * carry a flow object is rendered from it in full (the server's code and
 * message, the Next line, the facts, the retry time), whatever its HTTP
 * status. Anything else (an older server, a proxy's answer, a connection
 * failure) goes the old way: the per-code guidance `fallback` appended to
 * the server's message (rethrowWithGuidance), then the shared error mapper.
 * Always throws.
 */
export function rethrowSignupError(
  err: unknown,
  fallback: Record<string, string>,
  nameTool: ToolNamer = declared,
): never {
  const flow = flowOfError(err)
  if (flow !== null && err instanceof AgentChatError) {
    const wait = flow.retry_after_s !== undefined && flow.retry_after_s > 0 ? flow.retry_after_s : undefined
    throw new RenderedServerError(err.code || 'AGENTCHAT_ERROR', renderFlow(err.message ?? '', flow, nameTool), wait, err)
  }
  rethrowWithGuidance(err, fallback)
}

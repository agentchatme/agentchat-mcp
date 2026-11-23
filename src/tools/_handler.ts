import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import { mapAgentChatError } from '../errors.js'
import type { ServerMode } from '../instructions.js'
import type { Semaphore } from '../semaphore.js'
import type { ServerNotice } from './_types.js'

// ─── Shared tool-handler boilerplate ───────────────────────────────────────
//
// Every tool handler uses the same outer envelope:
//   1. Acquire a semaphore slot (blocks past AGENTCHAT_MAX_CONCURRENT_TOOLS).
//   2. Track the call promise in the shared `inflight` set so shutdown
//      can await it.
//   3. Log the invocation at debug with sanitised arguments.
//   4. Run the body inside try/catch that maps SDK errors → MCP errors.
//   5. Wrap the success payload in MCP's CallToolResult shape.
//   6. Show the host server's notices on the result (see "Server notices").
//   7. Always release the semaphore + remove from inflight, even on throw.
//
// The boundary keeps each tool file focused on the single API call plus
// response shaping; it cannot crash the server and it always honors
// backpressure + shutdown discipline.
//
// Server notices: a hosted endpoint passes the notices AgentChat has for the
// session (BuildMcpServerOptions.notices, e.g. "your wake trigger keeps
// failing"), so they reach an agent that never looks at its tray. Every
// result of every tool shows them, the way the result already speaks:
//   * a JSON result gets a top-level `notices` array, the notices as given,
//     placed before `next` when the result has one; a `notices` array the
//     result already carries (the tray's own) keeps its entries, and a notice
//     with the same kind and text is not shown twice;
//   * a text result (and an error) ends with one "AgentChat notice: <text>"
//     line per notice, after a blank line;
//   * an already-shaped result keeps its content untouched — its blocks can
//     hold a file's text — and gets those lines as one more text block.
// No notices (absent or empty) → every result is byte-identical to a build
// without the option.

export type SuccessShape =
  | string                           // simple text response
  | { type: 'json'; value: unknown } // JSON pretty-printed in a text block
  | CallToolResult                   // explicit shape for unusual cases

export interface BoundaryArgs {
  toolName: string
  logger: Logger
  /** Arguments object; must be JSON-stringifiable. Logged at debug level. */
  args: Record<string, unknown>
  /** Concurrency gate. Provided by the runtime; tests pass a no-op. */
  semaphore: Semaphore
  /** Active in-flight tracker. Shutdown awaits this set. */
  inflight: Set<Promise<unknown>>
  /**
   * Composition flavor for error guidance (ctx.mode). Absent means 'stdio'
   * — the historical default, which test contexts rely on.
   */
  mode?: ServerMode
  /**
   * The host server's notices for this session (ctx.notices), shown on the
   * result (see "Server notices"). Absent or empty = nothing is added.
   */
  notices?: readonly ServerNotice[] | undefined
}

/** How a text result names a server notice: one line each, the server's words after it. */
export const NOTICE_LINE_PREFIX = 'AgentChat notice: '

function noticeLines(notices: readonly ServerNotice[]): string {
  return notices.map((notice) => `${NOTICE_LINE_PREFIX}${notice.text}`).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `existing` (a result's own `notices` array) plus each notice it does not already show. */
function mergedNotices(existing: unknown, notices: readonly ServerNotice[]): unknown[] {
  if (!Array.isArray(existing)) return [...notices]
  const shown = (notice: ServerNotice) =>
    existing.some((entry) => isRecord(entry) && entry['kind'] === notice.kind && entry['text'] === notice.text)
  return [...existing, ...notices.filter((notice) => !shown(notice))]
}

/** A JSON result's value with the notices as its top-level `notices`, before `next`. */
function withNoticesField(value: Record<string, unknown>, notices: readonly ServerNotice[]): Record<string, unknown> {
  const merged = mergedNotices(value['notices'], notices)
  // An existing `notices` keeps its place; a new one goes before `next`, so
  // `next` stays the last word.
  if (!Object.hasOwn(value, 'next') || Object.hasOwn(value, 'notices')) return { ...value, notices: merged }
  const { next, ...rest } = value
  return { ...rest, notices: merged, next }
}

/** The CallToolResult for a body's answer, with the notices shown on it. */
function shapeSuccess(result: SuccessShape, notices: readonly ServerNotice[]): CallToolResult {
  const hasNotices = notices.length > 0

  if (typeof result === 'string') {
    const text = hasNotices ? `${result}\n\n${noticeLines(notices)}` : result
    return { content: [{ type: 'text', text }] }
  }

  if (
    typeof result === 'object' &&
    result !== null &&
    'type' in result &&
    result.type === 'json'
  ) {
    if (hasNotices && isRecord(result.value)) {
      return {
        content: [{ type: 'text', text: JSON.stringify(withNoticesField(result.value, notices), null, 2) }],
      }
    }
    const content: CallToolResult['content'] = [
      { type: 'text', text: JSON.stringify(result.value, null, 2) },
    ]
    // A JSON value that is not an object has no top level to carry them.
    if (hasNotices) content.push({ type: 'text', text: noticeLines(notices) })
    return { content }
  }

  // Already-shaped CallToolResult — pass through, its content untouched.
  const shaped = result as CallToolResult
  if (!hasNotices) return shaped
  return { ...shaped, content: [...shaped.content, { type: 'text', text: noticeLines(notices) }] }
}

/** An error result's text, with the notices' lines after it. */
function errorText(lines: string[], notices: readonly ServerNotice[]): string {
  return notices.length > 0 ? [...lines, '', noticeLines(notices)].join('\n') : lines.join('\n')
}

/**
 * Wrap a tool body with concurrency control, logging, error mapping, and
 * MCP envelope shaping. Every error path returns a non-throwing
 * CallToolResult with `isError: true` — the server never crashes from a
 * tool failure.
 */
export async function withErrorBoundary(
  meta: BoundaryArgs,
  body: () => Promise<SuccessShape>,
): Promise<CallToolResult> {
  const { toolName, logger, args, semaphore, inflight } = meta
  const notices = meta.notices ?? []

  // Build the work promise and immediately register it on the inflight
  // set so shutdown can await it. We use an outer async wrapper so the
  // promise reference exists before we call `inflight.add`.
  let resolveDone!: () => void
  const tracker = new Promise<void>((r) => {
    resolveDone = r
  })
  inflight.add(tracker)

  try {
    await semaphore.acquire()
  } catch (err) {
    // Acquire only throws if the semaphore is misused; treat as a fatal
    // tool error rather than crashing.
    inflight.delete(tracker)
    resolveDone()
    logger.error({ tool: toolName, err }, 'semaphore acquire failed')
    return {
      isError: true,
      content: [
        { type: 'text', text: errorText(['Error: INTERNAL_ERROR', '', 'Concurrency gate failed.'], notices) },
      ],
    }
  }

  logger.debug(
    { tool: toolName, args, inflight: semaphore.inFlight, queued: semaphore.waiting },
    'tool invoked',
  )

  try {
    return shapeSuccess(await body(), notices)
  } catch (err) {
    const mapped = mapAgentChatError(err, meta.mode)
    logger.warn(
      { tool: toolName, code: mapped.code, message: mapped.message },
      'tool failed',
    )

    const lines: string[] = [`Error: ${mapped.code}`, '', mapped.message]
    if (typeof mapped.retryAfterSeconds === 'number') {
      lines.push('', `Retry after: ${mapped.retryAfterSeconds} seconds.`)
    }

    return {
      isError: true,
      content: [{ type: 'text', text: errorText(lines, notices) }],
    }
  } finally {
    semaphore.release()
    inflight.delete(tracker)
    resolveDone()
  }
}

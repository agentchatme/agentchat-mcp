import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import { mapAgentChatError } from '../errors.js'
import type { Semaphore } from '../semaphore.js'

// ─── Shared tool-handler boilerplate ───────────────────────────────────────
//
// Every tool handler uses the same outer envelope:
//   1. Acquire a semaphore slot (blocks past AGENTCHAT_MAX_CONCURRENT_TOOLS).
//   2. Track the call promise in the shared `inflight` set so shutdown
//      can await it.
//   3. Log the invocation at debug with sanitised arguments.
//   4. Run the body inside try/catch that maps SDK errors → MCP errors.
//   5. Wrap the success payload in MCP's CallToolResult shape.
//   6. Always release the semaphore + remove from inflight, even on throw.
//
// The boundary keeps each tool file focused on the single API call plus
// response shaping; it cannot crash the server and it always honors
// backpressure + shutdown discipline.

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
      content: [{ type: 'text', text: 'Error: INTERNAL_ERROR\n\nConcurrency gate failed.' }],
    }
  }

  logger.debug(
    { tool: toolName, args, inflight: semaphore.inFlight, queued: semaphore.waiting },
    'tool invoked',
  )

  try {
    const result = await body()

    if (typeof result === 'string') {
      return { content: [{ type: 'text', text: result }] }
    }

    if (
      typeof result === 'object' &&
      result !== null &&
      'type' in result &&
      result.type === 'json'
    ) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      }
    }

    // Already-shaped CallToolResult — pass through.
    return result as CallToolResult
  } catch (err) {
    const mapped = mapAgentChatError(err)
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
      content: [{ type: 'text', text: lines.join('\n') }],
    }
  } finally {
    semaphore.release()
    inflight.delete(tracker)
    resolveDone()
  }
}

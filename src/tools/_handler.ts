import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import { mapAgentChatError } from '../errors.js'

// ─── Shared tool-handler boilerplate ───────────────────────────────────────
//
// Every tool handler does the same three things on its outer edge:
//   1. Log the call with sanitised arguments at debug level.
//   2. Run the body inside a try/catch that maps SDK errors to a
//      structured MCP error response.
//   3. Wrap the success payload in MCP's CallToolResult shape.
//
// `withErrorBoundary` consolidates that envelope so each tool file stays
// focused on the actual API call + response shaping.

export type SuccessShape =
  | string                           // simple text response
  | { type: 'json'; value: unknown } // JSON pretty-printed in a text block
  | CallToolResult                   // explicit shape for unusual cases

export interface BoundaryArgs {
  toolName: string
  logger: Logger
  /** Arguments object; must be JSON-stringifiable. Logged at debug level. */
  args: Record<string, unknown>
}

/**
 * Wrap a tool body with logging, error mapping, and MCP envelope shaping.
 * Every error path returns a non-throwing CallToolResult with `isError: true`
 * and a structured error payload — never crash the server on a tool failure.
 */
export async function withErrorBoundary(
  meta: BoundaryArgs,
  body: () => Promise<SuccessShape>,
): Promise<CallToolResult> {
  const { toolName, logger, args } = meta
  logger.debug({ tool: toolName, args }, 'tool invoked')

  try {
    const result = await body()

    if (typeof result === 'string') {
      return { content: [{ type: 'text', text: result }] }
    }

    if (typeof result === 'object' && result !== null && 'type' in result && result.type === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      }
    }

    // Already-shaped CallToolResult — pass through.
    return result as CallToolResult
  } catch (err) {
    const mapped = mapAgentChatError(err)
    logger.warn({ tool: toolName, code: mapped.code, message: mapped.message }, 'tool failed')

    const lines: string[] = [`Error: ${mapped.code}`, '', mapped.message]
    if (typeof mapped.retryAfterSeconds === 'number') {
      lines.push('', `Retry after: ${mapped.retryAfterSeconds} seconds.`)
    }

    return {
      isError: true,
      content: [{ type: 'text', text: lines.join('\n') }],
    }
  }
}

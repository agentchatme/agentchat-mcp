import {
  RateLimitedError,
  UnauthorizedError,
  type AgentChatErrorResponse,
} from 'agentchatme'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { withErrorBoundary } from '../../src/tools/_handler.js'

const silentLogger = pino({ level: 'silent' })

const res = (code: string, message: string): AgentChatErrorResponse => ({
  code,
  message,
})

describe('withErrorBoundary', () => {
  it('shapes a string success response as a single text block', async () => {
    const result = await withErrorBoundary(
      { toolName: 'test', logger: silentLogger, args: {} },
      async () => 'hello',
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('pretty-prints a JSON success response', async () => {
    const result = await withErrorBoundary(
      { toolName: 'test', logger: silentLogger, args: {} },
      async () => ({ type: 'json' as const, value: { ok: true, n: 42 } }),
    )
    expect(result.isError).toBeFalsy()
    const block = (result.content as Array<{ type: string; text: string }>)[0]!
    expect(block.type).toBe('text')
    expect(JSON.parse(block.text)).toEqual({ ok: true, n: 42 })
  })

  it('maps a rate-limit error to a structured response with retry hint', async () => {
    const result = await withErrorBoundary(
      { toolName: 'test', logger: silentLogger, args: {} },
      async () => {
        throw new RateLimitedError(res('RATE_LIMITED', 'rl'), 429, 5_000)
      },
    )
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('RATE_LIMITED')
    expect(text).toContain('Retry after: 5 seconds')
  })

  it('maps an unauthorized error to a clear message', async () => {
    const result = await withErrorBoundary(
      { toolName: 'test', logger: silentLogger, args: {} },
      async () => {
        throw new UnauthorizedError(res('UNAUTHORIZED', 'bad key'), 401)
      },
    )
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('UNAUTHORIZED')
    expect(text).toContain('AGENTCHAT_API_KEY')
  })

  it('catches unknown thrown values without crashing', async () => {
    const result = await withErrorBoundary(
      { toolName: 'test', logger: silentLogger, args: {} },
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'a bare string'
      },
    )
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('INTERNAL_ERROR')
  })
})

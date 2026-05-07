import {
  RateLimitedError,
  UnauthorizedError,
  type AgentChatErrorResponse,
} from 'agentchatme'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import { withErrorBoundary } from '../../src/tools/_handler.js'

const silentLogger = pino({ level: 'silent' })

const res = (code: string, message: string): AgentChatErrorResponse => ({
  code,
  message,
})

function makeMeta(extras: { semaphore?: Semaphore } = {}) {
  return {
    toolName: 'test',
    logger: silentLogger,
    args: {},
    semaphore: extras.semaphore ?? new Semaphore(10),
    inflight: new Set<Promise<unknown>>(),
  }
}

describe('withErrorBoundary', () => {
  it('shapes a string success response as a single text block', async () => {
    const result = await withErrorBoundary(makeMeta(), async () => 'hello')
    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('pretty-prints a JSON success response', async () => {
    const result = await withErrorBoundary(makeMeta(), async () => ({
      type: 'json' as const,
      value: { ok: true, n: 42 },
    }))
    expect(result.isError).toBeFalsy()
    const block = (result.content as Array<{ type: string; text: string }>)[0]!
    expect(block.type).toBe('text')
    expect(JSON.parse(block.text)).toEqual({ ok: true, n: 42 })
  })

  it('maps a rate-limit error to a structured response with retry hint', async () => {
    const result = await withErrorBoundary(makeMeta(), async () => {
      throw new RateLimitedError(res('RATE_LIMITED', 'rl'), 429, 5_000)
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('RATE_LIMITED')
    expect(text).toContain('Retry after: 5 seconds')
  })

  it('maps an unauthorized error to a clear message', async () => {
    const result = await withErrorBoundary(makeMeta(), async () => {
      throw new UnauthorizedError(res('UNAUTHORIZED', 'bad key'), 401)
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('UNAUTHORIZED')
    expect(text).toContain('AGENTCHAT_API_KEY')
  })

  it('catches unknown thrown values without crashing', async () => {
    const result = await withErrorBoundary(makeMeta(), async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'a bare string'
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('INTERNAL_ERROR')
  })

  it('removes the call from the inflight set on success', async () => {
    const meta = makeMeta()
    expect(meta.inflight.size).toBe(0)
    await withErrorBoundary(meta, async () => 'ok')
    expect(meta.inflight.size).toBe(0)
  })

  it('removes the call from the inflight set on error', async () => {
    const meta = makeMeta()
    await withErrorBoundary(meta, async () => {
      throw new Error('boom')
    })
    expect(meta.inflight.size).toBe(0)
  })

  it('releases the semaphore on success and on error', async () => {
    const sem = new Semaphore(2)
    const meta = makeMeta({ semaphore: sem })
    await withErrorBoundary(meta, async () => 'ok')
    expect(sem.inFlight).toBe(0)
    await withErrorBoundary(meta, async () => {
      throw new Error('boom')
    })
    expect(sem.inFlight).toBe(0)
  })

  it('queues calls past the semaphore ceiling', async () => {
    const sem = new Semaphore(1)
    const meta = makeMeta({ semaphore: sem })

    let firstResolve!: () => void
    const firstWaits = new Promise<void>((r) => {
      firstResolve = r
    })

    const first = withErrorBoundary(meta, async () => {
      await firstWaits
      return 'first'
    })

    // Give the first call a microtask to acquire the slot.
    await Promise.resolve()
    expect(sem.inFlight).toBe(1)

    // Second call should queue behind the first.
    const secondStarted = withErrorBoundary(meta, async () => 'second')
    await Promise.resolve()
    expect(sem.waiting).toBe(1)

    // Releasing the first lets the second proceed.
    firstResolve()
    await Promise.all([first, secondStarted])
    expect(sem.inFlight).toBe(0)
    expect(sem.waiting).toBe(0)
  })
})

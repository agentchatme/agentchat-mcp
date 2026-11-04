import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NotRegisteredError } from '../../src/client.js'
import { Semaphore } from '../../src/semaphore.js'
import * as waitTool from '../../src/tools/wait.js'
import type { ToolContext } from '../../src/tools/_types.js'

// agentchat_wait: the corridor's receive primitive. Network boundary stubbed;
// the tests pin (1) the exact long-poll request, (2) the ack that makes
// delivery truthful, (3) the compact per-conversation shaping, (4) the
// drain-only mode and the empty outcome, (5) host cancellation never acks,
// (6) the time budget composes under the 60 s host budgets, (7) ack retry +
// honest failure reporting, (8) blank arguments mean the defaults.

type FetchCall = {
  url: string
  method: string
  headers: Headers
  body: unknown
  signal: AbortSignal | undefined
}

function fetchStub(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { impl, calls }
}

/** A response that never comes — rejects the way undici does once the request signal aborts. */
function hang(call: FetchCall): Promise<Response> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (call.signal?.aborted) fail()
    else call.signal?.addEventListener('abort', fail, { once: true })
  })
}

const isSync = (call: FetchCall) => new URL(call.url).pathname === '/v1/messages/sync'
const isAck = (call: FetchCall) => call.url.endsWith('/v1/messages/sync/ack')

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

function makeCtx(
  fetchImpl: typeof fetch,
  apiKey: string | null = KEY,
  semaphore: Semaphore = new Semaphore(10),
): ToolContext {
  return {
    get client(): AgentChatClient {
      if (apiKey === null) throw new NotRegisteredError()
      return {} as AgentChatClient
    },
    logger: pino({ level: 'silent' }),
    selfHandle: '@me',
    semaphore,
    inflight: new Set(),
    rest: { apiBase: 'https://api.agentchat.test', apiKey, fetchImpl },
    turnKey: () => undefined,
  }
}

function firstText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text: string }>)[0]!.text
}

function payloadOf(result: { content: unknown[] }): Record<string, unknown> {
  return JSON.parse(firstText(result)) as Record<string, unknown>
}

const ROWS = [
  {
    id: 'msg_1',
    conversation_id: 'conv_1',
    delivery_id: 'del_1',
    sender: 'bob',
    type: 'text',
    seq: 7,
    created_at: '2026-10-28T10:00:00.000Z',
    content: { text: 'hi there' },
    context: {
      sender: { handle: 'bob', display_name: 'Bob', kind: 'agent' },
      conversation: { type: 'direct' },
      mentions: [],
    },
  },
  {
    id: 'msg_2',
    conversation_id: 'grp_9',
    delivery_id: null,
    sender: 'eve',
    type: 'text',
    seq: 41,
    created_at: '2026-10-28T10:00:01.000Z',
    content: { text: '@me ping' },
    metadata: { reply_to: 'msg_0' },
    context: {
      sender: { handle: 'eve', display_name: null, kind: 'agent' },
      conversation: { type: 'group', group_name: 'ops', member_count: 4 },
      mentions: ['me'],
    },
  },
  {
    id: 'msg_3',
    conversation_id: 'grp_9',
    delivery_id: 'del_3',
    sender: 'eve',
    type: 'text',
    seq: 42,
    created_at: '2026-10-28T10:00:02.000Z',
    content: { text: 'and again' },
    context: {
      sender: { handle: 'eve', kind: 'agent' },
      conversation: { type: 'group', group_name: 'ops', member_count: 4 },
    },
  },
]

describe('agentchat_wait handler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('long-polls /v1/messages/sync with wait_ms + limit, acks the batch cursor idempotently, and groups by conversation', async () => {
    const { impl, calls } = fetchStub((call) => {
      if (isSync(call)) return json(200, ROWS, { 'x-agentchat-waited-ms': '1234' })
      if (isAck(call)) return json(200, { acked: 3 })
      return json(404, { code: 'NOT_FOUND' })
    })
    const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50 })
    expect(result.isError).toBeFalsy()

    expect(calls).toHaveLength(2)
    const sync = new URL(calls[0]!.url)
    expect(sync.pathname).toBe('/v1/messages/sync')
    expect(sync.searchParams.get('wait_ms')).toBe('30000')
    expect(sync.searchParams.get('limit')).toBe('50')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(calls[1]!.method).toBe('POST')
    // Last NON-NULL delivery_id in wire order — the null row is skipped.
    expect(calls[1]!.body).toEqual({ last_delivery_id: 'del_3' })
    // The ack is idempotent and retry-eligible: it carries a per-call key.
    expect(calls[1]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)

    const payload = payloadOf(result)
    expect(payload).toMatchObject({
      you: '@me',
      outcome: 'messages',
      waited_ms: 1234,
      count: 3,
      acked: 3,
      has_more: false,
    })
    expect(payload).not.toHaveProperty('ack_error')
    const conversations = payload['conversations'] as Array<Record<string, unknown>>
    expect(conversations).toHaveLength(2)
    expect(conversations[0]).toMatchObject({
      conversation_id: 'conv_1',
      type: 'direct',
      group: null,
    })
    expect((conversations[0]!['messages'] as unknown[])[0]).toEqual({
      message_id: 'msg_1',
      seq: 7,
      sender: { handle: '@bob', display_name: 'Bob', kind: 'agent' },
      sent_at: '2026-10-28T10:00:00.000Z',
      message_type: 'text',
      content: { text: 'hi there' },
      mentioned_you: false,
    })
    expect(conversations[1]).toMatchObject({
      conversation_id: 'grp_9',
      type: 'group',
      group: { name: 'ops', member_count: 4 },
    })
    const groupMessages = conversations[1]!['messages'] as Array<Record<string, unknown>>
    expect(groupMessages).toHaveLength(2)
    expect(groupMessages[0]).toMatchObject({
      message_id: 'msg_2',
      mentioned_you: true,
      reply_to: { message_id: 'msg_0' },
    })
    expect(payload['next']).toContain('agentchat_wait again')
  })

  it('timeout_seconds: 0 drains without wait_ms and answers the empty outcome with no ack call', async () => {
    const { impl, calls } = fetchStub(() => json(200, []))
    const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 20 })
    expect(calls).toHaveLength(1)
    const sync = new URL(calls[0]!.url)
    expect(sync.searchParams.has('wait_ms')).toBe(false)
    expect(sync.searchParams.get('limit')).toBe('20')
    const payload = payloadOf(result)
    expect(payload).toMatchObject({ outcome: 'timeout', count: 0, acked: 0 })
    expect(payload['next']).toContain('stop')
  })

  it('surfaces the unauthenticated error without any network call', async () => {
    const { impl, calls } = fetchStub(() => json(200, []))
    const result = await waitTool.createHandler(makeCtx(impl, null))({ timeout_seconds: 5, limit: 50 })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })

  describe('ack failure (at-least-once)', () => {
    it('a 5xx ack is retried under one Idempotency-Key, then reported without hiding the messages', async () => {
      const { impl, calls } = fetchStub((call) =>
        isAck(call) ? json(500, { code: 'INTERNAL_ERROR', message: 'db' }) : json(200, [ROWS[0]]),
      )
      const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 5, limit: 50 })
      expect(result.isError).toBeFalsy()
      const payload = payloadOf(result)
      expect(payload['outcome']).toBe('messages')
      expect(payload['count']).toBe(1)
      expect(payload['acked']).toBe(0)
      expect(payload['ack_error']).toContain('NOT marked delivered')
      expect(payload['ack_error']).toContain('message_id')
      expect((payload['conversations'] as unknown[]).length).toBe(1)

      const acks = calls.filter(isAck)
      expect(acks).toHaveLength(1 + waitTool.ACK_RETRY_POLICY.maxRetries)
      const keys = new Set(acks.map((call) => call.headers.get('idempotency-key')))
      expect(keys.size).toBe(1)
      expect([...keys][0]).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('an ack network failure is retried, then the rows are still returned with ack_error guidance', async () => {
      const { impl, calls } = fetchStub((call) => {
        if (isAck(call)) throw new TypeError('fetch failed')
        return json(200, ROWS)
      })
      const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 5, limit: 50 })
      expect(result.isError).toBeFalsy()
      const payload = payloadOf(result)
      expect(payload['count']).toBe(3)
      expect(payload['acked']).toBe(0)
      expect(typeof payload['ack_error']).toBe('string')
      expect(payload['ack_error']).toContain('fetch failed')
      expect(payload['ack_error']).toContain('returned again by the next agentchat_wait')
      expect(payload['ack_error']).toContain('dedupe on message_id')
      expect(calls.filter(isAck)).toHaveLength(1 + waitTool.ACK_RETRY_POLICY.maxRetries)
    })
  })

  describe('host cancellation never acks', () => {
    it('an already-cancelled host signal returns at once with no network call', async () => {
      const { impl, calls } = fetchStub(() => json(200, ROWS))
      const ac = new AbortController()
      ac.abort()
      const result = await waitTool.createHandler(makeCtx(impl))(
        { timeout_seconds: 45, limit: 50 },
        { signal: ac.signal },
      )
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(0)
      expect(payloadOf(result)).toMatchObject({
        outcome: 'cancelled',
        cancelled_during: 'before-poll',
        count: 0,
        acked: 0,
        unacked: 0,
      })
    })

    it('cancelled while parked: the poll aborts at once and nothing is acked', async () => {
      const { impl, calls } = fetchStub((call) => hang(call))
      const ac = new AbortController()
      const pending = waitTool.createHandler(makeCtx(impl))(
        { timeout_seconds: 45, limit: 50 },
        { signal: ac.signal },
      )
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      ac.abort(new Error('host gave up'))
      const result = await pending
      expect(result.isError).toBeFalsy()
      expect(calls[0]!.signal?.aborted).toBe(true)
      expect(calls.filter(isAck)).toHaveLength(0)
      const payload = payloadOf(result)
      expect(payload).toMatchObject({ outcome: 'cancelled', cancelled_during: 'poll', acked: 0 })
      expect(payload['next']).toContain('Nothing was acked')
    })

    it('cancelled after rows arrived but before the ack: rows are left unacked for re-presentation', async () => {
      const ac = new AbortController()
      const { impl, calls } = fetchStub((call) => {
        if (isSync(call)) {
          // The host gives up exactly as the server answers.
          ac.abort()
          return json(200, ROWS)
        }
        return json(200, { acked: 3 })
      })
      const result = await waitTool.createHandler(makeCtx(impl))(
        { timeout_seconds: 5, limit: 50 },
        { signal: ac.signal },
      )
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      expect(calls.filter(isAck)).toHaveLength(0)
      const payload = payloadOf(result)
      expect(payload).toMatchObject({
        outcome: 'cancelled',
        cancelled_during: 'after-poll',
        count: 0,
        acked: 0,
        unacked: 3,
        conversations: [],
      })
      expect(payload['next']).toContain('agentchat_inbox')
    })

    it('cancelled while the ack is in flight: the result says delivery state is unknown', async () => {
      const ac = new AbortController()
      const { impl, calls } = fetchStub((call) => (isAck(call) ? hang(call) : json(200, ROWS)))
      const pending = waitTool.createHandler(makeCtx(impl))(
        { timeout_seconds: 5, limit: 50 },
        { signal: ac.signal },
      )
      await vi.waitFor(() => expect(calls.filter(isAck)).toHaveLength(1))
      ac.abort()
      const result = await pending
      expect(result.isError).toBeFalsy()
      // The deadline signal relays the host's abort into the in-flight ack,
      // and the transport does not retry a user abort.
      expect(calls.filter(isAck)).toHaveLength(1)
      expect(calls.filter(isAck)[0]!.signal?.aborted).toBe(true)
      const payload = payloadOf(result)
      expect(payload).toMatchObject({ outcome: 'cancelled', cancelled_during: 'ack', unacked: 3 })
      expect(payload['next']).toContain('unknown')
      expect(payload['next']).toContain('agentchat_inbox')
    })
  })

  describe('poll failures', () => {
    it('5xx on the poll: SERVER_ERROR after exactly one attempt, no ack', async () => {
      const { impl, calls } = fetchStub(() => json(503, { code: 'INTERNAL_ERROR', message: 'upstream' }))
      const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 45, limit: 50 })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain('SERVER_ERROR')
      expect(calls).toHaveLength(1)
      expect(calls.filter(isAck)).toHaveLength(0)
    })

    it('429 on the poll: RATE_LIMITED with inbox-polling guidance and the retry hint, one attempt', async () => {
      const { impl, calls } = fetchStub(() =>
        json(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'retry-after': '7' }),
      )
      const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 45, limit: 50 })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('Error: RATE_LIMITED')
      expect(text).toContain('polling is too frequent')
      expect(text).toContain('retry_after_ms')
      expect(text).toContain('Retry after: 7 seconds')
      expect(text).not.toContain('60 messages/second')
      expect(calls).toHaveLength(1)
    })
  })

  describe('time budget', () => {
    it('pins the constants against the 60 s host budgets', () => {
      expect(waitTool.HOST_BUDGET_MS).toBe(60_000)
      expect(waitTool.TOOL_DEADLINE_MS).toBe(55_000)
      expect(waitTool.TOOL_DEADLINE_MS + waitTool.HOST_BUDGET_MARGIN_MS).toBe(waitTool.HOST_BUDGET_MS)
      // The default park plus the ack reserve fits the deadline with headroom.
      expect(waitTool.DEFAULT_WAIT_SECONDS * 1000 + waitTool.ACK_RESERVE_MS).toBeLessThan(
        waitTool.TOOL_DEADLINE_MS,
      )
      expect(waitTool.MAX_WAIT_SECONDS * 1000).toBeLessThan(waitTool.TOOL_DEADLINE_MS - waitTool.ACK_RESERVE_MS)
    })

    it('composes the poll timeout as min(wait + headroom, deadline − ack reserve)', () => {
      const fresh = waitTool.TOOL_DEADLINE_MS
      expect(waitTool.composePollBudget(45_000, fresh)).toEqual({ waitMs: 45_000, timeoutMs: 52_000 })
      // The maximum park keeps its wait_ms; only the headroom shrinks.
      expect(waitTool.composePollBudget(50_000, fresh)).toEqual({ waitMs: 50_000, timeoutMs: 52_000 })
      expect(waitTool.composePollBudget(30_000, fresh)).toEqual({ waitMs: 30_000, timeoutMs: 40_000 })
      expect(waitTool.composePollBudget(0, fresh)).toEqual({ waitMs: 0, timeoutMs: 10_000 })
      // Budget partly spent before the poll (queued on the semaphore): the park
      // is trimmed so the server answers before the transport gives up.
      expect(waitTool.composePollBudget(45_000, 20_000)).toEqual({ waitMs: 15_000, timeoutMs: 17_000 })
      // Nearly nothing left: drain only, with a floor — never a 0 (= infinite) transport timeout.
      expect(waitTool.composePollBudget(45_000, 3_000)).toEqual({ waitMs: 0, timeoutMs: 2_000 })
      for (const remaining of [55_000, 20_000, 3_000, 0, -1_000]) {
        expect(waitTool.composePollBudget(50_000, remaining).timeoutMs).toBeGreaterThan(0)
      }
    })

    it('gives the ack a short per-attempt timeout clipped to what is left, and skips it when nothing is', () => {
      expect(waitTool.composeAckBudget(10_000)).toEqual({ timeoutMs: 5_000 })
      expect(waitTool.composeAckBudget(3_000)).toEqual({ timeoutMs: 3_000 })
      expect(waitTool.composeAckBudget(100)).toBeNull()
      expect(waitTool.composeAckBudget(-5)).toBeNull()
    })

    it('the default park gives up at exactly 52 s — inside the 60 s host budget — and never acks', async () => {
      vi.useFakeTimers()
      const { impl, calls } = fetchStub((call) => hang(call))
      const pending = waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 45, limit: 50 })
      await vi.advanceTimersByTimeAsync(51_999)
      expect(calls).toHaveLength(1)
      expect(new URL(calls[0]!.url).searchParams.get('wait_ms')).toBe('45000')
      expect(calls[0]!.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls[0]!.signal?.aborted).toBe(true)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain('CONNECTION_ERROR')
      expect(calls.filter(isAck)).toHaveLength(0)
    })

    it('anchors the deadline at entry: time queued on the semaphore trims the park sent to the server', async () => {
      vi.useFakeTimers()
      const { impl, calls } = fetchStub(() => json(200, []))
      const semaphore = new Semaphore(1)
      await semaphore.acquire() // another tool call holds the only slot
      const pending = waitTool.createHandler(makeCtx(impl, KEY, semaphore))({ timeout_seconds: 45, limit: 50 })
      await vi.advanceTimersByTimeAsync(20_000) // host budget burning while we queue
      expect(calls).toHaveLength(0)
      semaphore.release()
      const result = await pending
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      // composePollBudget(45_000, 35_000): poll budget 32 s → park 30 s.
      expect(new URL(calls[0]!.url).searchParams.get('wait_ms')).toBe('30000')
    })
  })

  describe('input schema', () => {
    it('blank timeout_seconds / limit (null, "", false) mean the defaults; 0 still means drain', () => {
      const schema = z.object(waitTool.INPUT_SHAPE)
      for (const blank of [undefined, null, '', false]) {
        expect(schema.parse({ timeout_seconds: blank, limit: blank })).toEqual({
          timeout_seconds: waitTool.DEFAULT_WAIT_SECONDS,
          limit: 50,
        })
      }
      expect(schema.parse({ timeout_seconds: 0, limit: 5 })).toEqual({ timeout_seconds: 0, limit: 5 })
      expect(schema.parse({ timeout_seconds: '30' }).timeout_seconds).toBe(30)
      expect(schema.safeParse({ timeout_seconds: waitTool.MAX_WAIT_SECONDS + 1 }).success).toBe(false)
      expect(schema.safeParse({ timeout_seconds: 'soon' }).success).toBe(false)
    })

    it('the blank handling leaves the emitted JSON Schema unchanged', () => {
      const schema = z.toJSONSchema(z.object(waitTool.INPUT_SHAPE), { target: 'draft-7', io: 'input' })
      const props = schema['properties'] as Record<string, Record<string, unknown>>
      expect(props['timeout_seconds']).toMatchObject({
        type: 'integer',
        minimum: 0,
        maximum: waitTool.MAX_WAIT_SECONDS,
        default: waitTool.DEFAULT_WAIT_SECONDS,
      })
      expect(typeof props['timeout_seconds']!['description']).toBe('string')
      expect(props['limit']).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
    })
  })

  it('pins the input schema bounds', () => {
    expect(waitTool.MAX_WAIT_SECONDS).toBe(50)
    expect(waitTool.DEFAULT_WAIT_SECONDS).toBe(45)
    expect(waitTool.ackCursorOf([{ delivery_id: 'a' }, { delivery_id: null }])).toBe('a')
    expect(waitTool.ackCursorOf([{ delivery_id: null }])).toBeNull()
  })
})

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
// honest failure reporting, (8) blank arguments mean the defaults, (9) the
// scoped wait (conversation_id + after_message_id, both or neither): one
// long-poll of that conversation, no ack, the same deadline and result shape
// plus next_after_message_id, an old server's plain answer refused, the
// caller's handle resolved before its own messages are left out, (10) a
// message hidden from you is marked could_not_process: true.

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

  describe('the scoped wait (conversation_id + after_message_id)', () => {
    const isScoped = (call: FetchCall) => new URL(call.url).pathname === '/v1/messages/conv_1'
    /** As GET /v1/messages/{id} serves them: the caller's own messages past the cursor included. */
    const PAGE = [
      {
        id: 'msg_6',
        conversation_id: 'conv_1',
        sender: 'me',
        type: 'text',
        seq: 6,
        created_at: '2026-11-19T10:00:00.000Z',
        content: { text: 'my answer' },
        context: { sender: { handle: 'me', kind: 'agent' }, conversation: { type: 'direct' }, mentions: [] },
        status: 'delivered',
      },
      {
        id: 'msg_7',
        conversation_id: 'conv_1',
        sender: 'bob',
        type: 'text',
        seq: 7,
        created_at: '2026-11-19T10:00:02.000Z',
        content: { text: 'thanks, one more thing' },
        context: { sender: { handle: 'bob', display_name: 'Bob', kind: 'agent' }, conversation: { type: 'direct' }, mentions: [] },
        status: 'delivered',
        delivered_at: '2026-11-19T10:00:03.000Z',
        read_at: null,
      },
    ]
    const scoped = { conversation_id: 'conv_1', after_message_id: 'msg_5' }

    it('one long-poll GET /v1/messages/{conversation_id}?after_message_id&wait_ms&limit, and no ack', async () => {
      const { impl, calls } = fetchStub((call) =>
        isScoped(call) ? json(200, PAGE, { 'x-agentchat-waited-ms': '2100' }) : json(404, { code: 'NOT_FOUND' }),
      )
      const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped })
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(call.method).toBe('GET')
      const url = new URL(call.url)
      expect(url.pathname).toBe('/v1/messages/conv_1')
      expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', after_message_id: 'msg_5', wait_ms: '30000' })
      expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
      // The fetch marks delivered server side: never the sync, never its ack.
      expect(calls.filter(isSync)).toHaveLength(0)
      expect(calls.filter(isAck)).toHaveLength(0)
    })

    it('answers in the unscoped shape: only the others’ messages, acked = what the fetch marked delivered', async () => {
      const { impl } = fetchStub(() => json(200, PAGE, { 'x-agentchat-waited-ms': '2100' }))
      const payload = payloadOf(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped }))
      // The unscoped shape, plus the cursor for the next call.
      expect(Object.keys(payload).sort()).toEqual(
        ['you', 'outcome', 'waited_ms', 'count', 'acked', 'has_more', 'security_boundary', 'conversations', 'next_after_message_id', 'next'].sort(),
      )
      // The last row served, the caller's own included.
      expect(payload['next_after_message_id']).toBe('msg_7')
      expect(payload).toMatchObject({ you: '@me', outcome: 'messages', waited_ms: 2100, count: 1, acked: 1, has_more: false })
      expect(payload['conversations']).toEqual([
        {
          conversation_id: 'conv_1',
          type: 'direct',
          group: null,
          messages: [
            {
              message_id: 'msg_7',
              seq: 7,
              sender: { handle: '@bob', display_name: 'Bob', kind: 'agent' },
              sent_at: '2026-11-19T10:00:02.000Z',
              message_type: 'text',
              content: { text: 'thanks, one more thing' },
              mentioned_you: false,
            },
          ],
        },
      ])
      expect(payload['next']).toBe(waitTool.NEXT.scopedMessages)
      expect(payload['next']).toContain('agentchat_wait again with this conversation_id and next_after_message_id as after_message_id')
    })

    it('nothing from the others: the timeout outcome, and one empty scoped wait means stop', async () => {
      const { impl } = fetchStub(() => json(200, [], { 'x-agentchat-waited-ms': '30000' }))
      const payload = payloadOf(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped }))
      expect(payload).toMatchObject({ outcome: 'timeout', waited_ms: 30000, count: 0, acked: 0, has_more: false, conversations: [] })
      // Nothing served: the cursor stays where it was.
      expect(payload['next_after_message_id']).toBe('msg_5')
      expect(payload['next']).toBe(waitTool.NEXT.scopedTimeout)
      expect(waitTool.NEXT.scopedTimeout).toBe('Nothing new arrived in this conversation: stop — the next message wakes you.')
    })

    it('only the caller’s own messages, under a page that is not full: nothing new, stop', async () => {
      const { impl } = fetchStub(() => json(200, [PAGE[0]], { 'x-agentchat-waited-ms': '30000' }))
      const payload = payloadOf(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped }))
      expect(payload).toMatchObject({ outcome: 'timeout', count: 0, has_more: false, next_after_message_id: 'msg_6' })
      expect(payload['next']).toBe(waitTool.NEXT.scopedTimeout)
    })

    it('a full page of the caller’s own messages moves the cursor on instead of stranding the model', async () => {
      const own = [5, 6, 7].map((seq) => ({ ...PAGE[0]!, id: `msg_own_${seq}`, seq: seq + 10 }))
      const { impl } = fetchStub(() => json(200, own))
      const payload = payloadOf(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 3, ...scoped }))
      expect(payload).toMatchObject({ outcome: 'timeout', count: 0, has_more: true, next_after_message_id: 'msg_own_7' })
      expect(payload['next']).toBe(waitTool.NEXT.scopedOwnOnly)
      expect(payload['next']).toContain('next_after_message_id as after_message_id')
    })

    it('has_more counts the page as served, own messages included', async () => {
      const { impl } = fetchStub(() => json(200, PAGE))
      const payload = payloadOf(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 2, ...scoped }))
      expect(payload).toMatchObject({ count: 1, has_more: true, next_after_message_id: 'msg_7' })
    })

    describe('a server without the scoped wait (it answers the newest page, newest first)', () => {
      const NEWEST_FIRST = [
        { ...PAGE[1]!, id: 'msg_9', seq: 9 },
        { ...PAGE[1]!, id: 'msg_8', seq: 8 },
      ]
      const refused = (result: { isError?: boolean; content: unknown[] }) => {
        expect(result.isError).toBe(true)
        expect(firstText(result)).toBe(`Error: SCOPED_WAIT_UNSUPPORTED\n\n${waitTool.SCOPED_WAIT_UNSUPPORTED_TEXT}`)
        expect(firstText(result)).toContain('This server cannot wait on one conversation')
        expect(firstText(result)).toContain('stop')
      }

      it('a wait answered without X-AgentChat-Waited-Ms is refused, never shown as new messages', async () => {
        const { impl, calls } = fetchStub(() => json(200, [PAGE[1]]))
        refused(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped }))
        expect(calls).toHaveLength(1)
      })

      it('the cursor’s own message in the page is refused (a read once, so no header is asked for)', async () => {
        const { impl } = fetchStub(() => json(200, [{ ...PAGE[1]!, id: 'msg_5', seq: 5 }]))
        refused(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 50, ...scoped }))
      })

      it('seqs that do not strictly ascend are refused', async () => {
        const { impl } = fetchStub(() => json(200, NEWEST_FIRST))
        refused(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 50, ...scoped }))
        const { impl: same } = fetchStub(() => json(200, [{ ...PAGE[1]!, id: 'msg_a', seq: 9 }, { ...PAGE[1]!, id: 'msg_b', seq: 9 }]))
        refused(await waitTool.createHandler(makeCtx(same))({ timeout_seconds: 0, limit: 50, ...scoped }))
      })

      it('servedWithoutScopedWait: each signal alone, and a scoped answer passes', () => {
        const rows = [{ id: 'msg_6', seq: 6 }, { id: 'msg_7', seq: 7 }, { id: 'msg_x' }]
        expect(waitTool.servedWithoutScopedWait(rows, 'msg_5', true)).toBe(false)
        expect(waitTool.servedWithoutScopedWait(rows, 'msg_5', null)).toBe(false)
        expect(waitTool.servedWithoutScopedWait([], 'msg_5', true)).toBe(false)
        expect(waitTool.servedWithoutScopedWait([], 'msg_5', false)).toBe(true)
        expect(waitTool.servedWithoutScopedWait(rows, 'msg_7', true)).toBe(true)
        expect(waitTool.servedWithoutScopedWait([{ id: 'msg_7', seq: 7 }, { id: 'msg_6', seq: 6 }], 'msg_1', null)).toBe(true)
      })
    })

    describe('the caller’s handle, before its own messages are left out', () => {
      const isMe = (call: FetchCall) => new URL(call.url).pathname === '/v1/agents/me'
      /** A stdio identity from an environment key: '?' until its handle is known. */
      const unknownHandleCtx = (impl: typeof fetch) => ({ ...makeCtx(impl), selfHandle: '?' })

      it('an unknown handle is asked for once, first, and then own messages are left out', async () => {
        const { impl, calls } = fetchStub((call) =>
          isMe(call) ? json(200, { handle: 'me', display_name: null }) : json(200, PAGE, { 'x-agentchat-waited-ms': '10' }),
        )
        const ctx = unknownHandleCtx(impl)
        const handler = waitTool.createHandler(ctx)
        const first = payloadOf(await handler({ timeout_seconds: 5, limit: 50, ...scoped }))
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/agents/me', '/v1/messages/conv_1'])
        expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
        expect(first).toMatchObject({ you: '@me', count: 1 })
        const ids = (first['conversations'] as Array<{ messages: Array<{ message_id: string }> }>)[0]!.messages.map((m) => m.message_id)
        expect(ids).toEqual(['msg_7'])
        // Cached for the session: the next call asks nothing more.
        await handler({ timeout_seconds: 5, limit: 50, ...scoped })
        expect(calls.filter(isMe)).toHaveLength(1)
        // A new key (a login mid-session) is asked for again.
        ctx.rest.apiKey = 'ac_live_ffffffffffffffffffffffffffffffff'
        await handler({ timeout_seconds: 5, limit: 50, ...scoped })
        expect(calls.filter(isMe)).toHaveLength(2)
      })

      it('a known handle asks nothing', async () => {
        const { impl, calls } = fetchStub(() => json(200, [], { 'x-agentchat-waited-ms': '10' }))
        await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 5, limit: 50, ...scoped })
        expect(calls.filter(isMe)).toHaveLength(0)
      })

      it('when the handle cannot be had, nothing is fetched (and so nothing is marked delivered)', async () => {
        const { impl, calls } = fetchStub((call) => (isMe(call) ? json(503, { code: 'INTERNAL_ERROR', message: 'down' }) : json(200, PAGE)))
        const result = await waitTool.createHandler(unknownHandleCtx(impl))({ timeout_seconds: 5, limit: 50, ...scoped })
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('SERVER_ERROR')
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/agents/me'])
      })

      it('an answer without a handle is an error, not a guess', async () => {
        const { impl, calls } = fetchStub((call) => (isMe(call) ? json(200, {}) : json(200, PAGE)))
        const result = await waitTool.createHandler(unknownHandleCtx(impl))({ timeout_seconds: 5, limit: 50, ...scoped })
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('answered without a handle')
        expect(calls.filter(isScoped)).toHaveLength(0)
      })

      it('the unscoped wait never asks (the sync carries no own messages)', async () => {
        const { impl, calls } = fetchStub(() => json(200, []))
        await waitTool.createHandler(unknownHandleCtx(impl))({ timeout_seconds: 0, limit: 50 })
        expect(calls.filter(isMe)).toHaveLength(0)
      })
    })

    it('timeout_seconds: 0 reads once: no wait_ms, still after the cursor', async () => {
      const { impl, calls } = fetchStub(() => json(200, []))
      await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 20, ...scoped })
      expect(calls).toHaveLength(1)
      expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({ limit: '20', after_message_id: 'msg_5' })
    })

    it('a conversation id is sent path-encoded', async () => {
      const { impl, calls } = fetchStub(() => json(200, []))
      await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 20, conversation_id: 'grp_a/b', after_message_id: 'msg_5' })
      expect(new URL(calls[0]!.url).pathname).toBe('/v1/messages/grp_a%2Fb')
    })

    describe('both or neither', () => {
      it('one without the other is a VALIDATION_ERROR before any network call', async () => {
        for (const half of [{ conversation_id: 'conv_1' }, { after_message_id: 'msg_5' }]) {
          const { impl, calls } = fetchStub(() => json(200, []))
          const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 5, limit: 50, ...half })
          expect(result.isError, JSON.stringify(half)).toBe(true)
          expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${waitTool.SCOPE_RULE}`)
          expect(calls).toHaveLength(0)
        }
      })

      it('the registered schema rejects half a scope; blanks (null, "", false) mean "not given"', () => {
        const schema = waitTool.INPUT_SCHEMA
        expect(schema.safeParse({ conversation_id: 'conv_1' }).success).toBe(false)
        expect(schema.safeParse({ after_message_id: 'msg_5' }).success).toBe(false)
        expect(schema.safeParse({ conversation_id: 'conv_1', after_message_id: 'msg_5' }).success).toBe(true)
        expect(schema.safeParse({}).success).toBe(true)
        for (const blank of [null, '', false]) {
          // Both blank: the unscoped wait, as if neither was sent.
          const both = schema.parse({ conversation_id: blank, after_message_id: blank })
          expect(both.conversation_id).toBeUndefined()
          expect(both.after_message_id).toBeUndefined()
          expect(waitTool.scopeOf(both)).toEqual({ kind: 'all' })
          // One blank, one given: still half a scope.
          expect(schema.safeParse({ conversation_id: 'conv_1', after_message_id: blank }).success).toBe(false)
          expect(schema.safeParse({ conversation_id: blank, after_message_id: 'msg_5' }).success).toBe(false)
        }
        const issue = schema.safeParse({ conversation_id: 'conv_1' })
        expect(issue.success ? null : issue.error.issues[0]!.message).toBe(waitTool.SCOPE_RULE)
      })

      it('blank ids at the handler (as a direct caller may send them) are the unscoped wait', async () => {
        const { impl, calls } = fetchStub((call) => (isAck(call) ? json(200, { acked: 0 }) : json(200, [])))
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 50 })
        expect(result.isError).toBeFalsy()
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/messages/sync'])
      })

      it('the emitted JSON Schema lists both as optional strings, required by nobody', () => {
        const schema = z.toJSONSchema(z.object(waitTool.INPUT_SHAPE), { target: 'draft-7', io: 'input' })
        const props = schema['properties'] as Record<string, Record<string, unknown>>
        expect(props['conversation_id']).toMatchObject({ type: 'string', minLength: 1 })
        expect(props['after_message_id']).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 })
        expect(typeof props['conversation_id']!['description']).toBe('string')
        expect(typeof props['after_message_id']!['description']).toBe('string')
        expect(schema['required'] ?? []).toEqual([])
      })
    })

    describe('deadline', () => {
      it('the default park gives up at exactly 52 s, inside the 60 s host budget', async () => {
        vi.useFakeTimers()
        const { impl, calls } = fetchStub((call) => hang(call))
        const pending = waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 45, limit: 50, ...scoped })
        await vi.advanceTimersByTimeAsync(51_999)
        expect(calls).toHaveLength(1)
        expect(new URL(calls[0]!.url).searchParams.get('wait_ms')).toBe('45000')
        expect(calls[0]!.signal?.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(calls[0]!.signal?.aborted).toBe(true)
        const result = await pending
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('CONNECTION_ERROR')
        expect(calls).toHaveLength(1)
      })

      it('anchored at entry: time queued on the semaphore trims the park sent to the server', async () => {
        vi.useFakeTimers()
        const { impl, calls } = fetchStub(() => json(200, [], { 'x-agentchat-waited-ms': '30000' }))
        const semaphore = new Semaphore(1)
        await semaphore.acquire()
        const pending = waitTool.createHandler(makeCtx(impl, KEY, semaphore))({ timeout_seconds: 45, limit: 50, ...scoped })
        await vi.advanceTimersByTimeAsync(20_000)
        expect(calls).toHaveLength(0)
        semaphore.release()
        const result = await pending
        expect(result.isError).toBeFalsy()
        // composePollBudget(45_000, 35_000): poll budget 32 s → park 30 s.
        expect(new URL(calls[0]!.url).searchParams.get('wait_ms')).toBe('30000')
      })
    })

    describe('host cancellation', () => {
      it('already cancelled: no network call', async () => {
        const { impl, calls } = fetchStub(() => json(200, PAGE))
        const ac = new AbortController()
        ac.abort()
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 45, limit: 50, ...scoped }, { signal: ac.signal })
        expect(calls).toHaveLength(0)
        expect(payloadOf(result)).toMatchObject({ outcome: 'cancelled', cancelled_during: 'before-poll', count: 0, acked: 0 })
      })

      it('cancelled while parked: the poll aborts at once, nothing else is sent', async () => {
        const { impl, calls } = fetchStub((call) => hang(call))
        const ac = new AbortController()
        const pending = waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 45, limit: 50, ...scoped }, { signal: ac.signal })
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        ac.abort(new Error('host gave up'))
        const result = await pending
        expect(calls[0]!.signal?.aborted).toBe(true)
        expect(calls).toHaveLength(1)
        const payload = payloadOf(result)
        expect(payload).toMatchObject({ outcome: 'cancelled', cancelled_during: 'poll', count: 0 })
        expect(payload['next']).toContain('the same conversation_id and after_message_id')
      })

      it('cancelled after the rows arrived: the result says the same after_message_id returns them', async () => {
        const ac = new AbortController()
        const { impl, calls } = fetchStub(() => {
          ac.abort()
          return json(200, PAGE)
        })
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 5, limit: 50, ...scoped }, { signal: ac.signal })
        expect(calls).toHaveLength(1)
        const payload = payloadOf(result)
        // The fetch marked the one message from bob delivered; none was handed over.
        expect(payload).toMatchObject({ outcome: 'cancelled', cancelled_during: 'after-poll', count: 0, acked: 1, unacked: 0, conversations: [] })
        expect(payload['next']).toContain('Nothing is lost')
      })
    })

    describe('refusals', () => {
      it('404 MESSAGE_NOT_FOUND: after_message_id is not of this conversation, one attempt', async () => {
        const { impl, calls } = fetchStub(() =>
          json(404, { code: 'MESSAGE_NOT_FOUND', message: 'after_message_id is not a message of this conversation' }),
        )
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped })
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('after_message_id is not a message of this conversation')
        expect(firstText(result)).toContain('Pass a message_id of the same conversation')
        expect(calls).toHaveLength(1)
      })

      it('403 FORBIDDEN: not a participant', async () => {
        const { impl } = fetchStub(() => json(403, { code: 'FORBIDDEN', message: 'You are not a participant in this conversation' }))
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped })
        expect(result.isError).toBe(true)
        expect(firstText(result)).toBe(
          'Error: FORBIDDEN\n\nYou are not a participant in this conversation. Use the conversation_id exactly as the card or agentchat_get_conversation gave it.',
        )
      })

      it('429: the polling guidance and the retry hint, one attempt', async () => {
        const { impl, calls } = fetchStub(() =>
          json(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'retry-after': '4' }),
        )
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped })
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('polling is too frequent')
        expect(firstText(result)).toContain('Retry after: 4 seconds')
        expect(calls).toHaveLength(1)
      })

      it('5xx: SERVER_ERROR after exactly one attempt', async () => {
        const { impl, calls } = fetchStub(() => json(503, { code: 'INTERNAL_ERROR', message: 'upstream' }))
        const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 30, limit: 50, ...scoped })
        expect(firstText(result)).toContain('SERVER_ERROR')
        expect(calls).toHaveLength(1)
      })

      it('unauthenticated: the composition’s error, nothing on the wire', async () => {
        const { impl, calls } = fetchStub(() => json(200, []))
        const result = await waitTool.createHandler(makeCtx(impl, null))({ timeout_seconds: 5, limit: 50, ...scoped })
        expect(firstText(result)).toContain('NOT_REGISTERED')
        expect(calls).toHaveLength(0)
      })
    })
  })

  describe('a message hidden from you (could not process)', () => {
    const NOTE =
      '[Hidden from you: this message from @bob could not be processed on your side, so it is not shown. You can ask @bob to rephrase or resend it.]'
    const HIDDEN = {
      ...ROWS[0]!,
      id: 'msg_h',
      type: 'text',
      content: { text: NOTE },
      metadata: {},
      could_not_process: { at: '2026-11-19T10:05:00.000Z', original_type: 'file' },
    }

    it('the sync wait shows it with could_not_process: true and the note as its text', async () => {
      const { impl } = fetchStub((call) => (isAck(call) ? json(200, { acked: 2 }) : json(200, [HIDDEN, ROWS[0]])))
      const payload = payloadOf(await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 50 }))
      const messages = (payload['conversations'] as Array<{ messages: Array<Record<string, unknown>> }>)[0]!.messages
      expect(messages[0]).toMatchObject({ message_id: 'msg_h', message_type: 'text', content: { text: NOTE }, could_not_process: true })
      expect(messages[0]!['could_not_process']).toBe(true)
      expect(messages[1]).not.toHaveProperty('could_not_process')
    })

    it('the scoped wait shows it the same way', async () => {
      const { impl } = fetchStub(() => json(200, [{ ...HIDDEN, delivery_id: undefined }]))
      const payload = payloadOf(
        await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 0, limit: 50, conversation_id: 'conv_1', after_message_id: 'msg_0' }),
      )
      const messages = (payload['conversations'] as Array<{ messages: Array<Record<string, unknown>> }>)[0]!.messages
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ message_id: 'msg_h', content: { text: NOTE }, could_not_process: true })
    })

    it('isHidden reads only an object as hidden', () => {
      expect(waitTool.isHidden({ could_not_process: { at: 'x', original_type: 'text' } })).toBe(true)
      for (const value of [undefined, null, true, 'yes', 1]) expect(waitTool.isHidden({ could_not_process: value })).toBe(false)
    })
  })

  it('pins the input schema bounds', () => {
    expect(waitTool.MAX_WAIT_SECONDS).toBe(50)
    expect(waitTool.DEFAULT_WAIT_SECONDS).toBe(45)
    expect(waitTool.ackCursorOf([{ delivery_id: 'a' }, { delivery_id: null }])).toBe('a')
    expect(waitTool.ackCursorOf([{ delivery_id: null }])).toBeNull()
  })
})

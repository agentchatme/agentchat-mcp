import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { NotRegisteredError } from '../../src/client.js'
import { Semaphore } from '../../src/semaphore.js'
import * as waitTool from '../../src/tools/wait.js'
import type { ToolContext } from '../../src/tools/_types.js'

// agentchat_wait: the corridor's receive primitive. Network boundary stubbed;
// the tests pin (1) the exact long-poll request, (2) the ack that makes
// delivery truthful, (3) the compact per-conversation shaping, (4) the
// drain-only mode and the empty outcome.

type FetchCall = { url: string; method: string; headers: Headers; body: unknown }

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
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { impl, calls }
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

function makeCtx(fetchImpl: typeof fetch, apiKey: string | null = KEY): ToolContext {
  return {
    get client(): AgentChatClient {
      if (apiKey === null) throw new NotRegisteredError()
      return {} as AgentChatClient
    },
    logger: pino({ level: 'silent' }),
    selfHandle: '@me',
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: { apiBase: 'https://api.agentchat.test', apiKey, fetchImpl },
    turnKey: () => undefined,
  }
}

function firstText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text: string }>)[0]!.text
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
  it('long-polls /v1/messages/sync with wait_ms + limit, acks the batch cursor, and groups by conversation', async () => {
    const { impl, calls } = fetchStub((call) => {
      if (call.url.includes('/v1/messages/sync?')) {
        return json(200, ROWS, { 'x-agentchat-waited-ms': '1234' })
      }
      if (call.url.endsWith('/v1/messages/sync/ack')) return json(200, { acked: 3 })
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

    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload).toMatchObject({
      you: '@me',
      outcome: 'messages',
      waited_ms: 1234,
      count: 3,
      acked: 3,
      has_more: false,
    })
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
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload).toMatchObject({ outcome: 'timeout', count: 0, acked: 0 })
    expect(payload['next']).toContain('stop')
  })

  it('reports a failed ack without hiding the messages', async () => {
    const { impl } = fetchStub((call) =>
      call.url.endsWith('/sync/ack') ? json(500, { code: 'INTERNAL_ERROR', message: 'db' }) : json(200, [ROWS[0]]),
    )
    const result = await waitTool.createHandler(makeCtx(impl))({ timeout_seconds: 5, limit: 50 })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload['count']).toBe(1)
    expect(payload['acked']).toBe(0)
    expect(typeof payload['ack_error']).toBe('string')
  })

  it('surfaces the unauthenticated error without any network call', async () => {
    const { impl, calls } = fetchStub(() => json(200, []))
    const result = await waitTool.createHandler(makeCtx(impl, null))({ timeout_seconds: 5, limit: 50 })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })

  it('pins the input schema bounds', () => {
    expect(waitTool.MAX_WAIT_SECONDS).toBe(50)
    expect(waitTool.DEFAULT_WAIT_SECONDS).toBe(45)
    expect(waitTool.ackCursorOf([{ delivery_id: 'a' }, { delivery_id: null }])).toBe('a')
    expect(waitTool.ackCursorOf([{ delivery_id: null }])).toBeNull()
  })
})

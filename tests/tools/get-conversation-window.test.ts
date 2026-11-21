import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildMcpServer } from '../../src/lib.js'
import * as getConversation from '../../src/tools/get-conversation.js'
import { fetchStub, json, KEY, makeRealCtx, payloadOf, type FetchCall } from './_real-client.js'

// ─── The default window of an anchored read ────────────────────────────────
//
// A woken agent opens a conversation with around_message_id = the card's
// preview message. With no limit, the window is what is new plus a little
// context: every message from the oldest unread one up to the anchor, plus
// the 3 before it (the anchor and the 3 before it when nothing up to it is
// unread), at most the newest 100. An explicit limit, and a call without an
// anchor, keep their meaning.
//
// The SDK client is real; the network is a small stand-in for the history
// and context endpoints with the server's semantics: around_message_id is a
// backwards window ending at that message, newest first; before_seq is rows
// with seq < N, newest first; the context's unread boundary is the reader's.

const CONV = 'conv_window'
const ME = 'me'
const PEER = 'peer'

type Row = {
  id: string
  conversation_id: string
  sender: string
  seq: number
  type: 'text'
  content: { text: string }
  metadata: Record<string, unknown>
  status: 'delivered' | 'read'
  created_at: string
  context: {
    sender: { handle: string; display_name: null; kind: 'agent' }
    conversation: { type: 'direct'; group_name: null; member_count: null }
    mentions: string[]
  }
}

interface History {
  seqs: number[]
  /** Peer messages at or after this seq are unread; none when null. */
  unreadFrom: number | null
  /** Seqs that are the reader's own messages. */
  own?: number[]
}

function rowsOf(history: History): Row[] {
  const own = new Set(history.own ?? [])
  return history.seqs.map((seq) => {
    const sender = own.has(seq) ? ME : PEER
    const unread = sender === PEER && history.unreadFrom !== null && seq >= history.unreadFrom
    return {
      id: `msg_${seq}`,
      conversation_id: CONV,
      sender,
      seq,
      type: 'text',
      content: { text: `message ${seq}` },
      metadata: {},
      status: unread ? 'delivered' : 'read',
      created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
      context: {
        sender: { handle: sender, display_name: null, kind: 'agent' },
        conversation: { type: 'direct', group_name: null, member_count: null },
        mentions: [],
      },
    }
  })
}

function unreadOf(rows: Row[]) {
  const unread = rows.filter((row) => row.sender === PEER && row.status !== 'read').map((row) => row.seq)
  return {
    count: unread.length,
    oldest_seq: unread.length > 0 ? Math.min(...unread) : null,
    newest_seq: unread.length > 0 ? Math.max(...unread) : null,
  }
}

/** The history and context endpoints over `rows`; everything else answers 404. */
function server(history: History, options: { context?: 'available' | 'unavailable' } = {}) {
  const rows = rowsOf(history)
  return fetchStub((call) => {
    const url = new URL(call.url)
    if (url.pathname === `/v1/conversations/${CONV}/context`) {
      if (options.context === 'unavailable') {
        return json(404, { code: 'NOT_FOUND', message: 'no context endpoint' })
      }
      return json(200, {
        conversation_id: CONV,
        type: 'direct',
        group: null,
        counterparty: { handle: PEER, display_name: null, avatar_url: null },
        relationship: { is_contact: false, added_at: null, note: null },
        unread: unreadOf(rows),
      })
    }
    if (url.pathname === `/v1/messages/${CONV}`) {
      const limit = Number(url.searchParams.get('limit'))
      const around = url.searchParams.get('around_message_id')
      const before = url.searchParams.get('before_seq')
      let eligible = [...rows].sort((a, b) => b.seq - a.seq)
      if (around !== null) {
        const anchor = rows.find((row) => row.id === around)
        if (!anchor) return json(404, { code: 'MESSAGE_NOT_FOUND', message: 'Anchor message not found in this conversation' })
        eligible = eligible.filter((row) => row.seq <= anchor.seq)
      }
      if (before !== null) eligible = eligible.filter((row) => row.seq < Number(before))
      return json(200, eligible.slice(0, limit))
    }
    return json(404, { code: 'NOT_FOUND', message: 'not here' })
  })
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

/** The history requests, as the query each one sent. */
function historyQueries(calls: FetchCall[]): Array<Record<string, string>> {
  return calls
    .filter((call) => new URL(call.url).pathname === `/v1/messages/${CONV}`)
    .map((call) => Object.fromEntries(new URL(call.url).searchParams))
}

type Payload = {
  messages: Array<{ message_id: string; seq: number }>
  focus: { message_id: string } | null
  unread: { count: number; oldest_seq: number | null; newest_seq: number | null }
  window: { count: number; oldest_seq: number | null; newest_seq: number | null; anchored_at_message_id: string | null }
  pagination: { older_before_seq: number | null; newer_after_seq: number | null; page_was_full: boolean }
}

async function read(
  impl: typeof fetch,
  args: Partial<getConversation.Input>,
): Promise<{ payload: Payload; isError: boolean | undefined }> {
  const handler = getConversation.createHandler(makeRealCtx(impl, { selfHandle: `@${ME}` }))
  const result = await handler({ conversation_id: CONV, ...args } as getConversation.Input)
  return {
    payload: result.isError ? (null as unknown as Payload) : (payloadOf(result) as unknown as Payload),
    isError: result.isError,
  }
}

const seqsOf = (payload: Payload) => payload.messages.map((message) => message.seq)

describe('agentchat_get_conversation — the default window of an anchored read', () => {
  describe('an unread run inside the window', () => {
    it('is the run up to the anchor plus the 3 messages before it', async () => {
      const { impl, calls } = server({ seqs: range(1, 50), unreadFrom: 46 })
      const { payload } = await read(impl, { around_message_id: 'msg_50' })

      expect(seqsOf(payload)).toEqual(range(43, 50))
      expect(payload.focus?.message_id).toBe('msg_50')
      expect(payload.unread).toEqual({ count: 5, oldest_seq: 46, newest_seq: 50 })
      expect(payload.window).toMatchObject({ count: 8, oldest_seq: 43, newest_seq: 50, anchored_at_message_id: 'msg_50' })
      expect(payload.pagination).toEqual({ older_before_seq: 43, newer_after_seq: 50, page_was_full: true })
      // The smallest window goes out with the context call; the second page
      // is sized from the seqs: 50 − 46 + 1 + 3.
      expect(historyQueries(calls)).toEqual([
        { limit: '4', around_message_id: 'msg_50' },
        { limit: '8', around_message_id: 'msg_50' },
      ])
    })

    it('when only the anchor is unread, the first page is the window: no second fetch', async () => {
      const { impl, calls } = server({ seqs: range(1, 50), unreadFrom: 50 })
      const { payload } = await read(impl, { around_message_id: 'msg_50' })

      expect(seqsOf(payload)).toEqual(range(47, 50))
      expect(payload.pagination).toEqual({ older_before_seq: 47, newer_after_seq: 50, page_was_full: true })
      expect(historyQueries(calls)).toEqual([{ limit: '4', around_message_id: 'msg_50' }])
    })

    it('keeps the reader\'s own messages inside the run, and exactly 3 before it across hidden seqs', async () => {
      // 41, 43, 46 and 49 are hidden from this reader (gaps in seq); 47 is
      // the reader's own message, sent while 45 was still unread.
      const seqs = [...range(1, 40), 42, 44, 45, 47, 48, 50]
      const { impl, calls } = server({ seqs, unreadFrom: 45, own: [47] })
      const { payload } = await read(impl, { around_message_id: 'msg_50' })

      expect(payload.unread).toEqual({ count: 3, oldest_seq: 45, newest_seq: 50 })
      expect(seqsOf(payload)).toEqual([40, 42, 44, 45, 47, 48, 50])
      // The seq span bounds the rows (50 − 45 + 1 + 3 = 9); the page is
      // trimmed to the run and its 3, so older messages certainly exist.
      expect(historyQueries(calls).map((query) => query['limit'])).toEqual(['4', '9'])
      expect(payload.pagination).toEqual({ older_before_seq: 40, newer_after_seq: 50, page_was_full: true })
    })

    it('ends at the anchor when newer unread messages arrived after it', async () => {
      const { impl, calls } = server({ seqs: range(1, 55), unreadFrom: 46 })
      const { payload } = await read(impl, { around_message_id: 'msg_50' })

      expect(seqsOf(payload)).toEqual(range(43, 50))
      expect(historyQueries(calls).map((query) => query['limit'])).toEqual(['4', '8'])
    })

    it('at the start of the conversation: everything there is, and page_was_full false', async () => {
      const { impl, calls } = server({ seqs: range(1, 3), unreadFrom: 2 })
      const { payload } = await read(impl, { around_message_id: 'msg_3' })

      expect(seqsOf(payload)).toEqual([1, 2, 3])
      expect(payload.pagination).toEqual({ older_before_seq: 1, newer_after_seq: 3, page_was_full: false })
      // A short first page is the whole history up to the anchor.
      expect(historyQueries(calls)).toEqual([{ limit: '4', around_message_id: 'msg_3' }])
    })
  })

  describe('an unread run longer than 100', () => {
    it('is the newest 100 up to the anchor, and says older messages exist', async () => {
      const { impl, calls } = server({ seqs: range(1, 300), unreadFrom: 101 })
      const { payload } = await read(impl, { around_message_id: 'msg_300' })

      expect(seqsOf(payload)).toEqual(range(201, 300))
      expect(payload.unread).toEqual({ count: 200, oldest_seq: 101, newest_seq: 300 })
      expect(payload.pagination).toEqual({ older_before_seq: 201, newer_after_seq: 300, page_was_full: true })
      expect(historyQueries(calls)).toEqual([
        { limit: '4', around_message_id: 'msg_300' },
        { limit: '100', around_message_id: 'msg_300' },
      ])
    })

    it('pages back from older_before_seq: 30 by default, or the limit given', async () => {
      const { impl, calls } = server({ seqs: range(1, 300), unreadFrom: 101 })
      const first = await read(impl, { around_message_id: 'msg_300' })
      const cursor = first.payload.pagination.older_before_seq as number

      const page = await read(impl, { before_seq: cursor })
      expect(seqsOf(page.payload)).toEqual(range(171, 200))
      expect(page.payload.pagination).toMatchObject({ older_before_seq: 171, page_was_full: true })

      const rest = await read(impl, { before_seq: cursor, limit: 100 })
      expect(seqsOf(rest.payload)).toEqual(range(101, 200))

      expect(historyQueries(calls).slice(2)).toEqual([
        { limit: '30', before_seq: '201' },
        { limit: '100', before_seq: '201' },
      ])
    })
  })

  describe('nothing unread up to the anchor', () => {
    it('no unread at all: the anchor and the 3 before it, in one page', async () => {
      const { impl, calls } = server({ seqs: range(1, 50), unreadFrom: null })
      const { payload } = await read(impl, { around_message_id: 'msg_50' })

      expect(payload.unread).toEqual({ count: 0, oldest_seq: null, newest_seq: null })
      expect(seqsOf(payload)).toEqual(range(47, 50))
      expect(payload.pagination).toEqual({ older_before_seq: 47, newer_after_seq: 50, page_was_full: true })
      expect(historyQueries(calls)).toEqual([{ limit: '4', around_message_id: 'msg_50' }])
    })

    it('unread only after the anchor: still the anchor and the 3 before it', async () => {
      const { impl, calls } = server({ seqs: range(1, 55), unreadFrom: 52 })
      const { payload } = await read(impl, { around_message_id: 'msg_50' })

      expect(seqsOf(payload)).toEqual(range(47, 50))
      expect(historyQueries(calls)).toHaveLength(1)
    })
  })

  describe('an explicit limit keeps its meaning', () => {
    it('with an anchor: one page of exactly that limit, untrimmed', async () => {
      const { impl, calls } = server({ seqs: range(1, 50), unreadFrom: 46 })

      const thirty = await read(impl, { around_message_id: 'msg_50', limit: 30 })
      expect(seqsOf(thirty.payload)).toEqual(range(21, 50))
      expect(thirty.payload.pagination).toEqual({ older_before_seq: 21, newer_after_seq: 50, page_was_full: true })

      const two = await read(impl, { around_message_id: 'msg_50', limit: 2 })
      expect(seqsOf(two.payload)).toEqual([49, 50])

      const hundred = await read(impl, { around_message_id: 'msg_50', limit: 100 })
      expect(seqsOf(hundred.payload)).toEqual(range(1, 50))
      expect(hundred.payload.pagination.page_was_full).toBe(false)

      expect(historyQueries(calls)).toEqual([
        { limit: '30', around_message_id: 'msg_50' },
        { limit: '2', around_message_id: 'msg_50' },
        { limit: '100', around_message_id: 'msg_50' },
      ])
    })
  })

  describe('a call without an anchor keeps the 30 default', () => {
    it('the newest 30, in one page', async () => {
      const { impl, calls } = server({ seqs: range(1, 50), unreadFrom: 46 })
      const { payload } = await read(impl, {})

      expect(seqsOf(payload)).toEqual(range(21, 50))
      expect(payload.pagination).toEqual({ older_before_seq: 21, newer_after_seq: 50, page_was_full: true })
      expect(historyQueries(calls)).toEqual([{ limit: '30' }])
    })
  })

  it('without an unread boundary (no context endpoint): the 30 default, as before', async () => {
    const { impl, calls } = server({ seqs: range(1, 50), unreadFrom: 46 }, { context: 'unavailable' })
    const { payload } = await read(impl, { around_message_id: 'msg_50' })

    expect(seqsOf(payload)).toEqual(range(21, 50))
    expect(payload.pagination.page_was_full).toBe(true)
    expect(historyQueries(calls)).toEqual([
      { limit: '4', around_message_id: 'msg_50' },
      { limit: '30', around_message_id: 'msg_50' },
    ])
  })

  it('an anchor the server does not return still fails closed', async () => {
    const { impl } = server({ seqs: range(1, 50), unreadFrom: 46 })
    const { isError } = await read(impl, { around_message_id: 'msg_999' })
    expect(isError).toBe(true)
  })
})

describe('agentchat_get_conversation — limit in the input schema', () => {
  it('has no fixed default, so an omitted limit reaches the handler as omitted', () => {
    const schema = z.object(getConversation.INPUT_SHAPE)
    expect(schema.parse({ conversation_id: CONV, around_message_id: 'msg_1' }).limit).toBeUndefined()
    expect(schema.parse({ conversation_id: CONV }).limit).toBeUndefined()
    expect(schema.parse({ conversation_id: CONV, limit: '5' }).limit).toBe(5)
    expect(() => schema.parse({ conversation_id: CONV, limit: 101 })).toThrow()
    expect(() => schema.parse({ conversation_id: CONV, limit: 0 })).toThrow()
  })

  it('the description says the default window and how to page back', () => {
    expect(getConversation.DESCRIPTION).toContain('the window is what is new plus a little context')
    expect(getConversation.DESCRIPTION).toContain('pass the returned pagination.older_before_seq as before_seq')
    expect(getConversation.DESCRIPTION).toContain('A limit you pass sets the window; without around_message_id it is the newest 30.')
  })

  describe('over MCP', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function callOverMcp(args: Record<string, unknown>, history: History) {
      const { impl, calls } = server(history)
      vi.stubGlobal('fetch', impl)
      const mcp = buildMcpServer({ apiBase: 'https://api.agentchat.test', apiKey: KEY, selfHandle: `@${ME}` })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'window-test', version: '0.0.0' })
      await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)])
      try {
        const result = await client.callTool({ name: getConversation.NAME, arguments: { conversation_id: CONV, ...args } })
        expect(result.isError).toBeFalsy()
        return { payload: payloadOf(result as { content: unknown[] }) as unknown as Payload, calls }
      } finally {
        await client.close()
        await mcp.close()
      }
    }

    it('an anchored call with no limit gets the unread window; a call with neither gets 30', async () => {
      const woken = await callOverMcp({ around_message_id: 'msg_50' }, { seqs: range(1, 50), unreadFrom: 46 })
      expect(seqsOf(woken.payload)).toEqual(range(43, 50))
      expect(historyQueries(woken.calls).map((query) => query['limit'])).toEqual(['4', '8'])

      const plain = await callOverMcp({}, { seqs: range(1, 50), unreadFrom: 46 })
      expect(seqsOf(plain.payload)).toEqual(range(21, 50))
      expect(historyQueries(plain.calls)).toEqual([{ limit: '30' }])
    })
  })
})

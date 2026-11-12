import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer, PACKAGE_VERSION } from '../../src/lib.js'
import { KEY } from './_real-client.js'

// ─── What a caller sees, pinned per server answer ──────────────────────────
//
// For every tool that reaches the server through a wire call of its own
// (the tray, the long-poll and its ack, invite dismiss, the wake-webhook
// trio, registration and verification), this suite drives the PUBLIC
// composition — buildMcpServer over a real MCP transport pair, the network
// stubbed at fetch — through a fixed set of server answers: the normal ones,
// the error codes each tool advises on, and the odd bodies a proxy can
// produce (empty, null, not JSON, missing the envelope, cut mid-read). It
// records what
// went on the wire (method, path, query, body, auth, identity, whether an
// Idempotency-Key was sent and whether retries reused it) and exactly what
// the MCP caller got back.
//
// The fixture was written by the 0.5.1 code, which drove these calls
// through the SDK's raw HttpTransport. Moving a call onto an SDK method must
// leave every entry unchanged; a change in what a caller sees is a contract
// change and has to be made on purpose.
//
// To regenerate after an INTENTIONAL change:
//   TOOL_OUTPUTS_FIXTURE_WRITE=1 pnpm vitest run tests/tools/tool-outputs.test.ts
// The run rewrites the fixture and then fails on purpose; review the diff,
// then re-run the suite normally.

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'tool-outputs.json',
)

const API_BASE = 'https://outputs.agentchat.test'

type Answer = () => Response

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Answer => () =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
const empty = (status: number): Answer => () => new Response(null, { status })
const text = (status: number, body: string): Answer => () =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } })
/** A 2xx whose connection is cut mid-body (undici raises `TypeError: terminated`). */
const cutOff = (status: number, partial: string): Answer => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partial))
        controller.error(new TypeError('terminated'))
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  )

interface Scenario {
  name: string
  tool: string
  args: Record<string, unknown>
  /** Answers in order; the last one repeats for any further call. */
  answers: Answer[]
  /** Session key; null = an unauthenticated session. Default: KEY. */
  apiKey?: string | null
}

interface WireCall {
  method: string
  path: string
  query: Array<[string, string]>
  body: unknown
  auth: 'bearer-session-key' | 'none' | 'other'
  client: string | null
  client_version_is_package: boolean
  idempotency_key: boolean
  content_type: string | null
}

interface Recorded {
  calls: WireCall[]
  /** With more than one keyed call: did every attempt carry the same key? */
  same_idempotency_key?: boolean
  result: { isError: boolean; content: unknown[] }
}

const TRAY_V1 = {
  version: 1,
  you: '@me',
  question: 'Does this conversation need a reply from you now?',
  categories: ['open_request', 'acknowledgement'],
  conversations: [
    {
      conversation_id: 'conv_1',
      type: 'direct',
      counterparty: { handle: '@peer-one', display_name: 'Peer One' },
      relationship: 'contact',
      you_owe_reply: true,
      mentioned_you: false,
      unread: 2,
      preview: { message_id: 'msg_2', text: 'are you there?' },
      your_last_decision: null,
      muted: false,
      card_extra: 'from a newer server',
    },
  ],
  invites: [{ invite_id: 'inv_1', group: { id: 'grp_1', name: 'Room', member_count: 3 }, invited_by: '@peer-two', at: '2026-11-10T00:00:00.000Z' }],
  invites_truncated: false,
  deferred: 1,
  truncated: false,
  waited_ms: 1200,
  tray_extra: { added: 'later' },
}

const SYNC_ROWS = [
  {
    id: 'msg_1',
    conversation_id: 'conv_1',
    delivery_id: 'del_1',
    sender: 'peer-one',
    type: 'text',
    seq: 4,
    created_at: '2026-11-10T00:00:01.000Z',
    content: { text: 'hello', extra: 'dropped' },
    metadata: { reply_to: 'msg_0' },
    context: { sender: { handle: '@Peer-One', display_name: 'Peer One', kind: 'agent' }, conversation: { type: 'direct' }, mentions: ['me'] },
  },
  {
    id: 'msg_9',
    conversation_id: 'grp_7',
    delivery_id: 'del_2',
    sender: 'peer-two',
    type: 'text',
    seq: 11,
    created_at: '2026-11-10T00:00:02.000Z',
    content: { text: 'group hello' },
    context: { sender: { handle: 'peer-two', kind: 'agent' }, conversation: { type: 'group', group_name: 'Room', member_count: 3 } },
  },
]

const WAKE_WEBHOOK = {
  url: 'https://hooks.example.com/wake',
  dialect: 'openclaw',
  prompt: null,
  state: 'active',
  consecutive_failures: 0,
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-11-10T00:00:00.000Z',
}

const SET_ARGS = { url: 'https://hooks.example.com/wake', secret: 'a-secret-of-sixteen+', dialect: 'openclaw' }

const SCENARIOS: Scenario[] = [
  // ── agentchat_inbox ──
  { name: 'inbox: tray v1 with cards, invites and unknown fields (default park)', tool: 'agentchat_inbox', args: {}, answers: [json(200, TRAY_V1)] },
  { name: 'inbox: look once, empty tray from a server before tray v1', tool: 'agentchat_inbox', args: { timeout_seconds: 0, limit: 5 }, answers: [json(200, { you: '@me', question: 'Q', conversations: [], deferred: 0, truncated: false, waited_ms: null })] },
  { name: 'inbox: only invites', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [json(200, { ...TRAY_V1, conversations: [], waited_ms: null })] },
  { name: 'inbox: 429 RATE_LIMITED with Retry-After', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [json(429, { code: 'RATE_LIMITED', message: 'slow down' }, { 'retry-after': '7' })] },
  { name: 'inbox: 400 VALIDATION_ERROR', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [json(400, { code: 'VALIDATION_ERROR', message: 'bad limit' })] },
  { name: 'inbox: 2xx body without conversations', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [json(200, { you: '@me' })] },
  { name: 'inbox: 2xx empty body', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [empty(200)] },
  { name: 'inbox: 503 is one attempt', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'down' })] },
  { name: 'inbox: 2xx body cut mid-read', tool: 'agentchat_inbox', args: { timeout_seconds: 0 }, answers: [cutOff(200, '{"conversations":[')] },
  { name: 'inbox: unauthenticated session', tool: 'agentchat_inbox', args: {}, answers: [json(200, TRAY_V1)], apiKey: null },

  // ── agentchat_wait ──
  { name: 'wait: two conversations, acked', tool: 'agentchat_wait', args: { timeout_seconds: 30, limit: 2 }, answers: [json(200, SYNC_ROWS, { 'x-agentchat-waited-ms': '850' }), json(200, { acked: 2 })] },
  { name: 'wait: drain, nothing waiting', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, [], { 'x-agentchat-waited-ms': '0' })] },
  { name: 'wait: fractional waited header', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, [], { 'x-agentchat-waited-ms': '12.7' })] },
  { name: 'wait: unreadable waited header', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, [], { 'x-agentchat-waited-ms': 'soon' })] },
  { name: 'wait: 2xx body that is not a list', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, { rows: SYNC_ROWS }, { 'x-agentchat-waited-ms': '0' })] },
  { name: 'wait: ack answers without a count', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, SYNC_ROWS.slice(0, 1), { 'x-agentchat-waited-ms': '3' }), json(200, {})] },
  { name: 'wait: ack fails on every attempt', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, SYNC_ROWS.slice(0, 1), { 'x-agentchat-waited-ms': '3' }), json(500, { code: 'INTERNAL_ERROR', message: 'ack down' })] },
  { name: 'wait: rows without a delivery cursor are not acked', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(200, [{ id: 'msg_5', conversation_id: 'conv_1', sender: 'peer-one', content: { text: 'x' } }], { 'x-agentchat-waited-ms': '1' })] },
  { name: 'wait: poll body cut mid-read', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [cutOff(200, '[{"id":"msg_1"')] },
  { name: 'wait: 429 RATE_LIMITED on the poll', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(429, { code: 'RATE_LIMITED', message: 'one at a time' }, { 'retry-after': '2' })] },
  { name: 'wait: 503 on the poll is one attempt', tool: 'agentchat_wait', args: { timeout_seconds: 0 }, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'down' })] },

  // ── agentchat_respond_to_invite (dismiss) ──
  { name: 'dismiss: dismissed', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv/1', response: 'dismiss' }, answers: [json(200, { dismissed: true })] },
  { name: 'dismiss: 404 INVITE_NOT_FOUND', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_2', response: 'dismiss' }, answers: [json(404, { code: 'INVITE_NOT_FOUND', message: 'no such invite' })] },
  { name: 'dismiss: bare 404 from a server without the endpoint', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_3', response: 'dismiss' }, answers: [empty(404)] },
  { name: 'dismiss: 503 then 200, retried under one key', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_4', response: 'dismiss' }, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'blip' }), json(200, { dismissed: true })] },
  { name: 'dismiss: 503 on every attempt', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_5', response: 'dismiss' }, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'down' })] },
  { name: 'dismiss: 2xx empty body', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_6', response: 'dismiss' }, answers: [empty(204)] },
  { name: 'dismiss: 2xx body cut mid-read', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_8', response: 'dismiss' }, answers: [cutOff(200, '{"dismi')] },
  { name: 'dismiss: unauthenticated session', tool: 'agentchat_respond_to_invite', args: { invite_id: 'inv_7', response: 'dismiss' }, answers: [json(200, { dismissed: true })], apiKey: null },

  // ── agentchat_set_webhook ──
  { name: 'set_webhook: registered, rewake echoed', tool: 'agentchat_set_webhook', args: { ...SET_ARGS, rewake: true, prompt: 'Check AgentChat.' }, answers: [json(200, { wake_webhook: { ...WAKE_WEBHOOK, prompt: 'Check AgentChat.', rewake: true } })] },
  { name: 'set_webhook: rewake sent, server does not echo it', tool: 'agentchat_set_webhook', args: { ...SET_ARGS, rewake: false }, answers: [json(200, { wake_webhook: WAKE_WEBHOOK })] },
  { name: 'set_webhook: defaults, no rewake key on the wire', tool: 'agentchat_set_webhook', args: { url: SET_ARGS.url, secret: SET_ARGS.secret }, answers: [json(200, { wake_webhook: { ...WAKE_WEBHOOK, dialect: 'agentchat', rewake: true } })] },
  { name: 'set_webhook: 400 INVALID_WAKE_WEBHOOK_URL', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [json(400, { code: 'INVALID_WAKE_WEBHOOK_URL', message: 'bad url for openclaw' })] },
  { name: 'set_webhook: 400 WAKE_WEBHOOK_URL_UNRESOLVED', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [json(400, { code: 'WAKE_WEBHOOK_URL_UNRESOLVED', message: 'no dns' })] },
  { name: 'set_webhook: 2xx empty body, rewake sent', tool: 'agentchat_set_webhook', args: { ...SET_ARGS, rewake: true }, answers: [empty(200)] },
  { name: 'set_webhook: 2xx JSON null', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [json(200, null)] },
  { name: 'set_webhook: 2xx without the envelope', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [json(200, { ok: true })] },
  { name: 'set_webhook: 2xx not JSON', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [text(200, '<html>ok</html>')] },
  { name: 'set_webhook: 2xx body cut mid-read', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [cutOff(200, '{"wake_webhook":{"url"')] },
  { name: 'set_webhook: 503 then 200 (PUT is retried)', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'blip' }), json(200, { wake_webhook: WAKE_WEBHOOK })] },
  { name: 'set_webhook: unauthenticated session', tool: 'agentchat_set_webhook', args: SET_ARGS, answers: [json(200, { wake_webhook: WAKE_WEBHOOK })], apiKey: null },

  // ── agentchat_test_webhook ──
  { name: 'test_webhook: receiver answered 2xx', tool: 'agentchat_test_webhook', args: {}, answers: [json(200, { test_wake: { ok: true, dialect: 'openclaw', url_host: 'hooks.example.com', status: 200, duration_ms: 41, error: null, delivery_id: 'wk_1' } })] },
  { name: 'test_webhook: receiver refused', tool: 'agentchat_test_webhook', args: {}, answers: [json(200, { test_wake: { ok: false, dialect: 'hermes', url_host: 'hooks.example.com', status: 401, duration_ms: 12, error: 'unauthorized', delivery_id: 'wk_2' } })] },
  { name: 'test_webhook: unknown dialect falls back to the generic hint', tool: 'agentchat_test_webhook', args: {}, answers: [json(200, { test_wake: { ok: false, dialect: 'future-runtime', status: null, error: 'timeout' } })] },
  { name: 'test_webhook: 404 WAKE_WEBHOOK_NOT_CONFIGURED', tool: 'agentchat_test_webhook', args: {}, answers: [json(404, { code: 'WAKE_WEBHOOK_NOT_CONFIGURED', message: 'none registered' })] },
  { name: 'test_webhook: 429 RATE_LIMITED', tool: 'agentchat_test_webhook', args: {}, answers: [json(429, { code: 'RATE_LIMITED', message: 'cap' }, { 'retry-after': '3600' })] },
  { name: 'test_webhook: 2xx empty body', tool: 'agentchat_test_webhook', args: {}, answers: [empty(200)] },
  { name: 'test_webhook: 2xx JSON null', tool: 'agentchat_test_webhook', args: {}, answers: [json(200, null)] },
  { name: 'test_webhook: 2xx without the envelope', tool: 'agentchat_test_webhook', args: {}, answers: [json(200, { ok: true })] },
  { name: 'test_webhook: 2xx with a null envelope', tool: 'agentchat_test_webhook', args: {}, answers: [json(200, { test_wake: null })] },
  { name: 'test_webhook: 2xx body cut mid-read', tool: 'agentchat_test_webhook', args: {}, answers: [cutOff(200, '{"test_wake":{"ok":tr')] },
  { name: 'test_webhook: 503 is one attempt', tool: 'agentchat_test_webhook', args: {}, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'down' })] },

  // ── agentchat_clear_webhook ──
  { name: 'clear_webhook: removed', tool: 'agentchat_clear_webhook', args: {}, answers: [json(200, { ok: true, removed: true })] },
  { name: 'clear_webhook: nothing to remove', tool: 'agentchat_clear_webhook', args: {}, answers: [json(200, { ok: true, removed: false })] },
  { name: 'clear_webhook: 204', tool: 'agentchat_clear_webhook', args: {}, answers: [empty(204)] },
  { name: 'clear_webhook: 401 UNAUTHORIZED', tool: 'agentchat_clear_webhook', args: {}, answers: [json(401, { code: 'UNAUTHORIZED', message: 'bad key' })] },
  { name: 'clear_webhook: 2xx body cut mid-read', tool: 'agentchat_clear_webhook', args: {}, answers: [cutOff(200, '{"ok":tr')] },
  { name: 'clear_webhook: 503 then 200 (DELETE is retried)', tool: 'agentchat_clear_webhook', args: {}, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'blip' }), json(200, { ok: true, removed: true })] },

  // ── agentchat_register ──
  { name: 'register: pending', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(200, { pending_id: 'pend_1', message: 'Code sent' })], apiKey: null },
  { name: 'register: with a session key, still sent without one', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(201, { pending_id: 'pend_2', message: 'Code sent', expires_in: 600 })] },
  { name: 'register: 409 HANDLE_TAKEN', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'taken-bot' }, answers: [json(409, { code: 'HANDLE_TAKEN', message: 'handle taken-bot is taken' })], apiKey: null },
  { name: 'register: 400 INVALID_HANDLE', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(400, { code: 'INVALID_HANDLE', message: 'Handle is invalid or reserved' })], apiKey: null },
  { name: 'register: 409 EMAIL_LIMIT_REACHED', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(409, { code: 'EMAIL_LIMIT_REACHED', message: 'limit reached', details: { limit: 10 } })], apiKey: null },
  { name: 'register: 409 EMAIL_EXHAUSTED', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(409, { code: 'EMAIL_EXHAUSTED', message: 'limit reached', details: { limit: 30 } })], apiKey: null },
  { name: 'register: 429 with Retry-After', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(429, { code: 'RATE_LIMITED', message: 'too many' }, { 'retry-after': '120' })], apiKey: null },
  { name: 'register: 429 RATE_LIMITED without Retry-After (the per-address limit)', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(429, { code: 'RATE_LIMITED', message: 'Too many requests. Try again in 3600 seconds.' })], apiKey: null },
  { name: 'register: 429 OTP_COOLDOWN', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(429, { code: 'OTP_COOLDOWN', message: 'Please wait 42s before requesting another code.' }, { 'retry-after': '42' })], apiKey: null },
  { name: 'register: 429 OTP_HOURLY_CAP', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(429, { code: 'OTP_HOURLY_CAP', message: 'Maximum 20 verification codes per hour. Please try again later.' }, { 'retry-after': '1800' })], apiKey: null },
  { name: 'register: 500 OTP_FAILED', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(500, { code: 'OTP_FAILED', message: 'Failed to send verification code' })], apiKey: null },
  { name: 'register: 503 is one attempt', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'down' })], apiKey: null },
  { name: 'register: 2xx without pending_id', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [json(200, { message: 'ok' })], apiKey: null },
  { name: 'register: 2xx empty body', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [empty(200)], apiKey: null },
  { name: 'register: 2xx body cut mid-read', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [cutOff(200, '{"pending_id":"pe')], apiKey: null },
  { name: 'register: 2xx not JSON', tool: 'agentchat_register', args: { email: 'owner@example.com', handle: 'fresh-bot' }, answers: [text(200, '<html>ok</html>')], apiKey: null },

  // ── agentchat_verify_otp ──
  { name: 'verify: key minted', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(200, { api_key: 'ac_live_minted', agent: { handle: 'fresh-bot', id: 'agt_1' } })], apiKey: null },
  { name: 'verify: key minted, no agent in the answer', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(201, { api_key: 'ac_live_minted' })], apiKey: null },
  { name: 'verify: with a session key, still sent without one', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(200, { api_key: 'ac_live_minted', agent: { handle: 'fresh-bot' } })] },
  { name: 'verify: 400 INVALID_CODE', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '000000' }, answers: [json(400, { code: 'INVALID_CODE', message: 'wrong code' })], apiKey: null },
  { name: 'verify: 400 EXPIRED', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_x', code: '123456' }, answers: [json(400, { code: 'EXPIRED', message: 'Registration expired or invalid. Please start again.' })], apiKey: null },
  { name: 'verify: 429 OTP_ATTEMPTS_EXHAUSTED', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(429, { code: 'OTP_ATTEMPTS_EXHAUSTED', message: 'Too many incorrect codes (max 5). Please request a new one.' })], apiKey: null },
  { name: 'verify: 429 OTP_EMAIL_LOCKED', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(429, { code: 'OTP_EMAIL_LOCKED', message: 'Too many wrong codes for this email. Try again in 15 minutes.', retry_after_s: 900 }, { 'retry-after': '900' })], apiKey: null },
  { name: 'verify: 409 HANDLE_TAKEN (taken after the code was accepted)', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(409, { code: 'HANDLE_TAKEN', message: 'Handle @fresh-bot is already taken' })], apiKey: null },
  { name: 'verify: 409 EMAIL_LIMIT_REACHED (another registration finished first)', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(409, { code: 'EMAIL_LIMIT_REACHED', message: 'limit reached', details: { limit: 10 } })], apiKey: null },
  { name: 'verify: 503 is one attempt', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(503, { code: 'INTERNAL_ERROR', message: 'down' })], apiKey: null },
  { name: 'verify: 2xx without api_key', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(200, { agent: { handle: 'fresh-bot' } })], apiKey: null },
  { name: 'verify: 2xx with an empty api_key', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(200, { api_key: '', agent: { handle: 'fresh-bot' } })], apiKey: null },
  { name: 'verify: 2xx empty body', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [empty(200)], apiKey: null },
  { name: 'verify: 2xx JSON null', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [json(200, null)], apiKey: null },
  { name: 'verify: 2xx body cut mid-read', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [cutOff(200, '{"api_key":"ac_li')], apiKey: null },
  { name: 'verify: 2xx not JSON', tool: 'agentchat_verify_otp', args: { pending_id: 'pend_1', code: '123456' }, answers: [text(200, '<html>ok</html>')], apiKey: null },
]

function authOf(headers: Headers): WireCall['auth'] {
  const value = headers.get('authorization')
  if (value === null) return 'none'
  return value === `Bearer ${KEY}` ? 'bearer-session-key' : 'other'
}

async function run(scenario: Scenario): Promise<Recorded> {
  const calls: WireCall[] = []
  const keys: string[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init?.headers)
    const raw = init?.body
    let body: unknown = null
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const key = headers.get('idempotency-key')
    if (key !== null) keys.push(key)
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)),
      body,
      auth: authOf(headers),
      client: headers.get('x-agentchat-client'),
      client_version_is_package: headers.get('x-agentchat-client-version') === PACKAGE_VERSION,
      idempotency_key: key !== null,
      content_type: headers.get('content-type'),
    })
    const answer = scenario.answers[Math.min(calls.length - 1, scenario.answers.length - 1)]!
    return answer()
  }) as typeof fetch
  vi.stubGlobal('fetch', impl)

  const server = buildMcpServer({
    apiBase: API_BASE,
    apiKey: scenario.apiKey === undefined ? KEY : scenario.apiKey,
    selfHandle: 'me',
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'tool-outputs', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const result = await client.callTool({ name: scenario.tool, arguments: scenario.args })
    const content = (result.content as Array<{ type: string; text?: string }>).map((item) => {
      if (item.type !== 'text' || typeof item.text !== 'string') return item
      try {
        return { type: 'json', value: JSON.parse(item.text) as unknown }
      } catch {
        return { type: 'text', text: item.text }
      }
    })
    return {
      calls,
      ...(keys.length > 1 ? { same_idempotency_key: keys.every((k) => k === keys[0]) } : {}),
      result: { isError: result.isError === true, content },
    }
  } finally {
    await client.close()
    await server.close()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what a caller sees from the tools with their own wire calls', () => {
  it('every scenario name is unique', () => {
    const names = SCENARIOS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('matches the pinned outputs, scenario by scenario', async () => {
    const recorded: Record<string, Recorded> = {}
    for (const scenario of SCENARIOS) recorded[scenario.name] = await run(scenario)

    if (process.env['TOOL_OUTPUTS_FIXTURE_WRITE'] === '1') {
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(recorded, null, 2)}\n`)
      throw new Error(`fixture rewritten at ${FIXTURE_PATH}; review the diff, then re-run without TOOL_OUTPUTS_FIXTURE_WRITE`)
    }

    const pinned = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, Recorded>
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(pinned).sort())
    for (const scenario of SCENARIOS) {
      expect(recorded[scenario.name], scenario.name).toEqual(pinned[scenario.name])
    }
  }, 60_000)
})

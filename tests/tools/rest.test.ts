import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentChatClient, AgentChatError, ConnectionError } from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { isUnreadAnswer, watchAnswers } from '../../src/tools/_rest.js'

// ─── tools/_rest.ts: every call through an SDK method ──────────────────────

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

describe('the tools reach the server through SDK methods only', () => {
  it('no source file drives the SDK transport by hand', () => {
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, path.relative(SRC, file)).not.toMatch(/\bHttpTransport\b/)
      expect(text, path.relative(SRC, file)).not.toMatch(/\.request(<[^>]*>)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'/)
    }
  })
})

describe('watchAnswers', () => {
  const sequence = (responses: Array<() => Response>) => {
    const queue = [...responses]
    return (async () => queue.shift()!()) as typeof fetch
  }

  it('remembers whether the last answer was a 2xx with an empty or JSON-null body, once its body has been read', async () => {
    const watch = watchAnswers(
      sequence([
        () => new Response('', { status: 200 }),
        () => new Response('{"a":1}', { status: 200 }),
        () => new Response(null, { status: 204 }),
        () => new Response(' null ', { status: 201 }),
        () => new Response('', { status: 503 }),
        () => new Response('<html>ok</html>', { status: 200 }),
      ]),
    )
    expect(watch.answeredEmpty()).toBe(false)
    const seen: boolean[] = []
    for (let i = 0; i < 6; i += 1) {
      const res = await watch.fetch('https://x.test/a')
      await res.text() // the transport reads the body; the verdict comes at its end
      seen.push(watch.answeredEmpty())
    }
    // '' · JSON · 204 · null · 503 (not a 2xx) · not JSON (the SDK raises that itself)
    expect(seen).toEqual([true, false, true, true, false, false])
  })

  it('decides only when the body has ended: before that, nothing is empty', async () => {
    const watch = watchAnswers(sequence([() => new Response('', { status: 200 })]))
    const res = await watch.fetch('https://x.test/a')
    expect(watch.answeredEmpty()).toBe(false)
    await res.text()
    expect(watch.answeredEmpty()).toBe(true)
  })

  it('hands the transport the same status, headers and text', async () => {
    const watch = watchAnswers(
      sequence([() => new Response('{"wake_webhook":{"state":"active"}}', { status: 201, statusText: 'Created', headers: { 'x-request-id': 'req_1', 'content-type': 'application/json' } })]),
    )
    const res = await watch.fetch('https://x.test/p', { method: 'PUT' })
    expect([res.status, res.statusText, res.ok]).toEqual([201, 'Created', true])
    expect(res.headers.get('x-request-id')).toBe('req_1')
    expect(await res.text()).toBe('{"wake_webhook":{"state":"active"}}')
  })

  it('a slow 2xx body is read outside the request timeout, as the transport always read it', async () => {
    const slow = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{"test_wake":{"ok":true}}'))
              controller.close()
            }, 150)
          },
        }),
        { status: 200 },
      )
    const watch = watchAnswers(sequence([slow]))
    const client = new AgentChatClient({ apiKey: 'test-key', baseUrl: 'https://x.test', fetch: watch.fetch, timeoutMs: 50 })
    await expect(client.wakeWebhook.test({ retry: 'never' })).resolves.toMatchObject({ ok: true })
    expect(watch.answeredEmpty()).toBe(false)
  })

  it('passes a non-2xx answer through untouched, body unread', async () => {
    const original = new Response('{"code":"NOT_FOUND","message":"none"}', { status: 404 })
    const watch = watchAnswers(sequence([() => original]))
    const res = await watch.fetch('https://x.test/a')
    expect(res).toBe(original)
    expect(res.bodyUsed).toBe(false)
  })

  it('a body cut mid-read is no empty answer, and fails the same way when the transport reads it', async () => {
    const cut = new TypeError('terminated')
    const watch = watchAnswers(
      sequence([
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"wake_web'))
                controller.error(cut)
              },
            }),
            { status: 200 },
          ),
      ]),
    )
    const res = await watch.fetch('https://x.test/a')
    expect(watch.answeredEmpty()).toBe(false)
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toBe(cut)
  })

  it('a fetch that throws leaves no answer behind and passes the request through', async () => {
    let seen: { input: unknown; init: RequestInit | undefined } | null = null
    let fail = false
    const watch = watchAnswers((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = { input, init }
      if (fail) throw new TypeError('fetch failed')
      return new Response('', { status: 200 })
    }) as typeof fetch)
    const init = { method: 'POST', headers: { a: 'b' }, body: '{"x":1}' }
    await (await watch.fetch('https://x.test/p', init)).text()
    expect(seen).toEqual({ input: 'https://x.test/p', init })
    expect(watch.answeredEmpty()).toBe(true)
    fail = true
    await expect(watch.fetch('https://x.test/p')).rejects.toThrow('fetch failed')
    expect(watch.answeredEmpty()).toBe(false)
  })
})

describe('isUnreadAnswer: a 2xx whose body the SDK could not read', () => {
  it('is a TypeError after an empty or null 2xx, and nothing else', () => {
    const unread = new TypeError("Cannot read properties of undefined (reading 'wake_webhook')")
    expect(isUnreadAnswer(unread, true)).toBe(true)
    // Without such an answer a TypeError is a failure like any other (a body
    // cut mid-read included: watchAnswers does not count it as empty).
    expect(isUnreadAnswer(unread, false)).toBe(false)
  })

  it('every failed call keeps failing, 2xx or not', () => {
    const failures: unknown[] = [
      new AgentChatError({ code: 'INTERNAL_ERROR', message: 'down' }, 503),
      // A 2xx body that is not JSON, a connection failure, a timeout.
      new ConnectionError('AgentChat SDK: expected JSON response but got: <html>'),
      Object.assign(new Error('Request aborted'), { name: 'AbortError' }),
      new Error('anything else'),
      'a string',
    ]
    for (const err of failures) {
      expect(isUnreadAnswer(err, true), String(err)).toBe(false)
      expect(isUnreadAnswer(err, false), String(err)).toBe(false)
    }
  })
})

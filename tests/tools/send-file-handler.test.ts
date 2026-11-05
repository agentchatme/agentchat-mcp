import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as sendFile from '../../src/tools/send-file.js'
import { fetchStub, firstText, json, KEY, makeRealCtx, pathOf, payloadOf, type FetchCall } from './_real-client.js'

// agentchat_send_file: reserve (POST /v1/uploads) → PUT the bytes to the
// presigned URL → send a `file` message. The local path source is confined
// to the working directory (resolved and real); the hosted composition
// refuses paths and takes bytes. Nothing is sent when the upload fails.

// The handler reads paths relative to process.cwd(), so the fixtures live
// in a scratch folder INSIDE the working directory, removed afterwards.
const SCRATCH = path.join(process.cwd(), `.send-file-test-${process.pid}-${randomBytes(4).toString('hex')}`)
const OUTSIDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-send-file-'))
const NOTE_TEXT = 'hello from the test\n'

beforeAll(() => {
  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'note.txt'), NOTE_TEXT)
  fs.writeFileSync(path.join(SCRATCH, 'mystery.bin'), 'x')
  fs.writeFileSync(path.join(SCRATCH, 'empty.md'), '')
  fs.writeFileSync(path.join(OUTSIDE_DIR, 'secret.txt'), 'not yours')
  fs.symlinkSync(path.join(OUTSIDE_DIR, 'secret.txt'), path.join(SCRATCH, 'escape.txt'))
})

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true })
})

const rel = (name: string) => path.relative(process.cwd(), path.join(SCRATCH, name))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const UPLOAD_URL = 'https://store.test/put/att_1?token=abc'

/** The happy-path network: reserve → store PUT → send. */
function happyNetwork() {
  return fetchStub((call: FetchCall) => {
    if (call.url.startsWith('https://store.test/')) return new Response(null, { status: 200 })
    if (pathOf(call) === '/v1/uploads') {
      return json(201, { attachment_id: 'att_1', upload_url: UPLOAD_URL, expires_in: 7200 })
    }
    if (pathOf(call) === '/v1/messages') {
      return json(201, {
        id: 'msg_f1',
        conversation_id: 'conv_1',
        sender: 'me',
        client_msg_id: 'c1',
        seq: 7,
        type: 'file',
        content: { attachment_id: 'att_1' },
        metadata: {},
        status: 'stored',
        created_at: '2026-11-04T10:00:00.000Z',
        delivered_at: null,
        read_at: null,
      })
    }
    return json(404, { code: 'NOT_FOUND', message: `unexpected ${call.method} ${call.url}` })
  })
}

describe('agentchat_send_file input rules', () => {
  it('exactly one of path or bytes; bytes needs filename', () => {
    const ok = (v: unknown) => sendFile.INPUT_SCHEMA.safeParse(v).success
    expect(ok({ to: '@bob', path: 'a.txt' })).toBe(true)
    expect(ok({ to: '@bob', bytes: 'aGVsbG8=', filename: 'a.txt' })).toBe(true)
    expect(ok({ to: '@bob' })).toBe(false)
    expect(ok({ to: '@bob', path: 'a.txt', bytes: 'aGVsbG8=', filename: 'a.txt' })).toBe(false)
    expect(ok({ to: '@bob', bytes: 'aGVsbG8=' })).toBe(false)
    expect(sendFile.sourceIssue({ path: undefined, bytes: undefined, filename: undefined })).toBe(sendFile.SOURCE_RULE)
    // The refine adds nothing to the wire schema.
    const opts = { target: 'draft-7', io: 'input' } as const
    expect(z.toJSONSchema(sendFile.INPUT_SCHEMA, opts)).toEqual(z.toJSONSchema(z.object(sendFile.INPUT_SHAPE), opts))
  })

  it('infers the content type from the extension, only for the allowed types', () => {
    expect(sendFile.inferContentType('report.PDF')).toBe('application/pdf')
    expect(sendFile.inferContentType('notes.md')).toBe('text/markdown')
    expect(sendFile.inferContentType('photo.jpeg')).toBe('image/jpeg')
    expect(sendFile.inferContentType('data.csv')).toBe('text/csv')
    expect(sendFile.inferContentType('archive.zip')).toBeNull()
    expect(sendFile.inferContentType('page.html')).toBeNull()
    expect(sendFile.inferContentType('noext')).toBeNull()
  })

  it('decodes strict base64 and refuses anything else', () => {
    expect(sendFile.decodeBase64('aGVs\nbG8=').toString()).toBe('hello')
    expect(() => sendFile.decodeBase64('data:text/plain;base64,aGVsbG8=')).toThrow(/standard base64/)
    expect(() => sendFile.decodeBase64('aGVsbG8')).toThrow(/standard base64/)
    expect(() => sendFile.decodeBase64('====')).toThrow(/standard base64/)
    expect(() => sendFile.decodeBase64('   ')).toThrow(/standard base64/)
    expect(sendFile.MAX_BYTES).toBe(25 * 1024 * 1024)
    expect(sendFile.MAX_BASE64_CHARS).toBe(Math.ceil(sendFile.MAX_BYTES / 3) * 4)
  })
})

describe('agentchat_send_file: the local path source', () => {
  it('reads a file inside the working directory and refuses one outside it, before any network', async () => {
    const inside = await sendFile.readLocalFile(rel('note.txt'), process.cwd())
    expect(inside.filename).toBe('note.txt')
    expect(inside.bytes.toString()).toBe(NOTE_TEXT)

    await expect(sendFile.readLocalFile(path.join(OUTSIDE_DIR, 'secret.txt'), process.cwd())).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKDIR',
    })
    await expect(sendFile.readLocalFile(path.join('..', '..', 'etc', 'hosts'), process.cwd())).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKDIR',
    })
    // A symlink inside pointing outside is caught on the REAL path.
    await expect(sendFile.readLocalFile(rel('escape.txt'), process.cwd())).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKDIR',
    })
    await expect(sendFile.readLocalFile(rel('missing.txt'), process.cwd())).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    })
    await expect(sendFile.readLocalFile(rel(''), process.cwd())).rejects.toMatchObject({ code: 'NOT_A_FILE' })
    await expect(sendFile.readLocalFile(rel('empty.md'), process.cwd())).rejects.toMatchObject({ code: 'EMPTY_FILE' })
  })

  it('uploads then sends, in that order, with the right bodies — and no Authorization on the store PUT', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl))({
      to: '@Bob',
      path: rel('note.txt'),
      caption: 'the note',
    })
    expect(result.isError).toBeFalsy()

    expect(calls.map((c) => [c.method, c.url.startsWith('https://store.test/') ? 'store' : pathOf(c)])).toEqual([
      ['POST', '/v1/uploads'],
      ['PUT', 'store'],
      ['POST', '/v1/messages'],
    ])
    expect(calls[0]!.body).toEqual({
      to: '@Bob',
      filename: 'note.txt',
      content_type: 'text/plain',
      size: NOTE_TEXT.length,
      sha256: sha(NOTE_TEXT),
    })
    const put = calls[1]!
    expect(put.url).toBe(UPLOAD_URL)
    expect(put.headers.get('authorization')).toBeNull()
    expect(put.headers.get('content-type')).toBe('text/plain')
    expect(Buffer.from(put.rawBody as Uint8Array).toString()).toBe(NOTE_TEXT)

    const send = calls[2]!.body as Record<string, unknown>
    expect(send).toMatchObject({
      to: '@Bob',
      type: 'file',
      content: { attachment_id: 'att_1', text: 'the note' },
      metadata: { file: { filename: 'note.txt', content_type: 'text/plain', size: NOTE_TEXT.length, sha256: sha(NOTE_TEXT) } },
    })
    expect(typeof send['client_msg_id']).toBe('string')
    expect(calls[2]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)

    expect(payloadOf(result)).toEqual({
      ok: true,
      message_id: 'msg_f1',
      conversation_id: 'conv_1',
      seq: 7,
      created_at: '2026-11-04T10:00:00.000Z',
      attachment: {
        attachment_id: 'att_1',
        filename: 'note.txt',
        content_type: 'text/plain',
        size: NOTE_TEXT.length,
        sha256: sha(NOTE_TEXT),
      },
    })
  })

  it('a group target goes as conversation_id on both the reservation and the send', async () => {
    const { impl, calls } = happyNetwork()
    await sendFile.createHandler(makeRealCtx(impl))({ to: 'grp_1', path: rel('note.txt') })
    expect(calls[0]!.body).toMatchObject({ conversation_id: 'grp_1' })
    expect(calls[2]!.body).toMatchObject({ conversation_id: 'grp_1', content: { attachment_id: 'att_1' } })
    expect((calls[2]!.body as { content: Record<string, unknown> }).content['text']).toBeUndefined()
  })

  it('refuses a direct-conversation id up front and says to use the peer’s handle, with zero network calls', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl))({ to: 'conv_abc', path: rel('note.txt') })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${sendFile.DIRECT_ID_RULE}`)
    expect(firstText(result)).toContain('@handle')
    expect(calls).toHaveLength(0)
  })

  it('refuses a path outside the working directory with its own code and zero network calls', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl))({
      to: '@bob',
      path: path.join(OUTSIDE_DIR, 'secret.txt'),
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: PATH_OUTSIDE_WORKDIR')
    expect(calls).toHaveLength(0)
  })

  it('an unknown extension without content_type is refused before the network; content_type unlocks it', async () => {
    const { impl, calls } = happyNetwork()
    const handler = sendFile.createHandler(makeRealCtx(impl))
    const refused = await handler({ to: '@bob', path: rel('mystery.bin') })
    expect(refused.isError).toBe(true)
    expect(firstText(refused)).toContain('Error: CONTENT_TYPE_REQUIRED')
    expect(calls).toHaveLength(0)

    const sent = await handler({ to: '@bob', path: rel('mystery.bin'), content_type: 'application/pdf' })
    expect(sent.isError).toBeFalsy()
    expect(calls[0]!.body).toMatchObject({ content_type: 'application/pdf', filename: 'mystery.bin' })
  })

  it('the hosted composition refuses paths outright and asks for bytes', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl, { mode: 'hosted' }))({
      to: '@bob',
      path: rel('note.txt'),
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: PATH_NOT_AVAILABLE')
    expect(firstText(result)).toContain('Pass bytes')
    expect(calls).toHaveLength(0)
  })
})

describe('agentchat_send_file: the bytes source', () => {
  it('decodes base64, infers the type from filename, and sends', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl, { mode: 'hosted' }))({
      to: '@bob',
      bytes: Buffer.from('# hi\n').toString('base64'),
      filename: 'readme.md',
    })
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.body).toEqual({
      to: '@bob',
      filename: 'readme.md',
      content_type: 'text/markdown',
      size: 5,
      sha256: sha('# hi\n'),
    })
    expect(Buffer.from(calls[1]!.rawBody as Uint8Array).toString()).toBe('# hi\n')
  })

  it('the hosted composition clamps bytes to what its body cap can carry, at the schema and in the handler', async () => {
    expect(sendFile.HOSTED_MAX_BYTES).toBe(180 * 1024)
    expect(sendFile.maxBytesFor('hosted')).toBe(sendFile.HOSTED_MAX_BYTES)
    expect(sendFile.maxBytesFor('stdio')).toBe(sendFile.MAX_BYTES)
    expect(sendFile.maxBytesFor(undefined)).toBe(sendFile.MAX_BYTES)
    // 180 KiB of file is ~240 KiB of base64: inside the 256 KiB hosted body cap.
    expect(sendFile.maxBase64CharsFor('hosted')).toBeLessThan(sendFile.HOSTED_BODY_LIMIT_BYTES)

    const tooBig = Buffer.alloc(sendFile.HOSTED_MAX_BYTES + 1, 1).toString('base64')
    const hostedSchema = sendFile.inputSchemaFor('hosted')
    expect(hostedSchema.safeParse({ to: '@bob', bytes: tooBig, filename: 'a.txt' }).success).toBe(false)
    expect(sendFile.inputSchemaFor('stdio').safeParse({ to: '@bob', bytes: tooBig, filename: 'a.txt' }).success).toBe(true)
    const hostedBytes = (z.toJSONSchema(z.object(sendFile.buildInputShape('hosted')), { target: 'draft-7', io: 'input' })[
      'properties'
    ] as Record<string, Record<string, unknown>>)['bytes']!
    expect(hostedBytes['maxLength']).toBe(sendFile.maxBase64CharsFor('hosted'))
    expect(String(hostedBytes['description'])).toContain('180 KiB')
    expect(String(hostedBytes['description'])).toContain('stdio binary’s path form')
    expect(sendFile.DESCRIPTION).toContain('stdio binary’s path form')

    // A direct handler call in hosted mode is clamped too, with the reason.
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl, { mode: 'hosted' }))({
      to: '@bob',
      bytes: tooBig,
      filename: 'a.txt',
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: FILE_TOO_LARGE')
    expect(firstText(result)).toContain('stdio binary’s path form')
    expect(calls).toHaveLength(0)
  })

  it('invalid base64 is refused with zero network calls', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl))({
      to: '@bob',
      bytes: 'not base64!!',
      filename: 'a.txt',
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: INVALID_BASE64')
    expect(calls).toHaveLength(0)
  })

  it('both sources at once is a validation error in the handler too', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl))({
      to: '@bob',
      path: rel('note.txt'),
      bytes: 'aGVsbG8=',
      filename: 'a.txt',
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${sendFile.SOURCE_RULE}`)
    expect(calls).toHaveLength(0)
  })
})

describe('agentchat_send_file: failure paths', () => {
  it('a rejected reservation keeps the server message and adds guidance; nothing is uploaded or sent', async () => {
    const { impl, calls } = fetchStub(() => json(403, { code: 'BLOCKED', message: 'Messaging between these accounts is blocked' }))
    const result = await sendFile.createHandler(makeRealCtx(impl))({ to: '@bob', path: rel('note.txt') })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: BLOCKED')
    expect(calls).toHaveLength(1)
  })

  it('a failed store PUT is UPLOAD_FAILED and no message is sent', async () => {
    const { impl, calls } = fetchStub((call) => {
      if (call.url.startsWith('https://store.test/')) return new Response('signature expired', { status: 403 })
      return json(201, { attachment_id: 'att_1', upload_url: UPLOAD_URL, expires_in: 7200 })
    })
    const result = await sendFile.createHandler(makeRealCtx(impl))({ to: '@bob', path: rel('note.txt') })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: UPLOAD_FAILED')
    expect(firstText(result)).toContain('403')
    expect(firstText(result)).toContain('signature expired')
    expect(firstText(result)).toContain('Nothing was sent')
    expect(calls.filter((c) => pathOf(c) === '/v1/messages')).toHaveLength(0)
  })

  it('a reservation without an upload_url fails closed', async () => {
    const { impl, calls } = fetchStub(() => json(201, { attachment_id: 'att_1' }))
    const result = await sendFile.createHandler(makeRealCtx(impl))({ to: '@bob', path: rel('note.txt') })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('no attachment_id/upload_url')
    expect(calls).toHaveLength(1)
  })

  it('no identity: no network at all', async () => {
    const { impl, calls } = happyNetwork()
    const result = await sendFile.createHandler(makeRealCtx(impl, { apiKey: null }))({ to: '@bob', path: rel('note.txt') })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })
})

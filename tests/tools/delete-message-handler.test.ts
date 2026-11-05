import { describe, expect, it } from 'vitest'
import * as deleteMessage from '../../src/tools/delete-message.js'
import { fetchStub, firstText, json, makeRealCtx, pathOf, payloadOf } from './_real-client.js'

// agentchat_delete_message: DELETE /v1/messages/{id}, hide-for-me only.

describe('agentchat_delete_message', () => {
  it('DELETEs the message and says the other side keeps its copy', async () => {
    const { impl, calls } = fetchStub(() => json(200, { message: 'Message hidden from your view' }))
    const result = await deleteMessage.createHandler(makeRealCtx(impl))({ message_id: 'msg_1' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('DELETE')
    expect(pathOf(calls[0]!)).toBe('/v1/messages/msg_1')
    expect(payloadOf(result)).toEqual({
      ok: true,
      message_id: 'msg_1',
      scope: 'your_view_only',
      note: 'Other participants still see this message.',
    })
    expect(deleteMessage.DESCRIPTION).toContain('no delete-for-everyone')
  })

  it('percent-encodes the id', async () => {
    const { impl, calls } = fetchStub(() => json(200, { message: 'ok' }))
    await deleteMessage.createHandler(makeRealCtx(impl))({ message_id: 'msg a/b' })
    expect(pathOf(calls[0]!)).toBe('/v1/messages/msg%20a%2Fb')
  })

  it('403 FORBIDDEN keeps the server message and adds the participant guidance', async () => {
    const { impl } = fetchStub(() => json(403, { code: 'FORBIDDEN', message: 'server says FORBIDDEN' }))
    const result = await deleteMessage.createHandler(makeRealCtx(impl))({ message_id: 'msg_1' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: FORBIDDEN')
    expect(firstText(result)).toContain('server says FORBIDDEN')
    expect(firstText(result)).toMatch(/not a participant/)
  })

  it('404 MESSAGE_NOT_FOUND maps to NOT_FOUND with the message-id guidance', async () => {
    const { impl } = fetchStub(() => json(404, { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' }))
    const result = await deleteMessage.createHandler(makeRealCtx(impl))({ message_id: 'msg_1' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: NOT_FOUND')
    expect(firstText(result)).toMatch(/message_id agentchat_get_conversation returned/)
  })
})

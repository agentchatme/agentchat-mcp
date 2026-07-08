import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import * as addContact from '../../src/tools/add-contact.js'
import * as unblockAgent from '../../src/tools/unblock-agent.js'
import type { ToolContext } from '../../src/tools/_types.js'

function makeCtx(client: Partial<AgentChatClient>): ToolContext {
  return {
    client: client as AgentChatClient,
    logger: pino({ level: 'silent' }),
    selfHandle: '@test',
    semaphore: new Semaphore(10),
    inflight: new Set(),
  }
}

function parseJsonContent(result: { content: unknown[] }): unknown {
  const block = (result.content as Array<{ type: string; text: string }>)[0]!
  return JSON.parse(block.text)
}

describe('agentchat_add_contact with note', () => {
  it('adds then writes the note via updateContactNotes', async () => {
    const addContactMock = vi.fn().mockResolvedValue({ handle: 'alice' })
    const updateNotesMock = vi.fn().mockResolvedValue({ handle: 'alice', notes: 'embeddings supplier' })
    const handler = addContact.createHandler(
      makeCtx({ addContact: addContactMock, updateContactNotes: updateNotesMock }),
    )
    const result = await handler({ handle: '@alice', note: 'embeddings supplier' })
    expect(addContactMock).toHaveBeenCalledWith('@alice')
    expect(updateNotesMock).toHaveBeenCalledWith('@alice', 'embeddings supplier')
    expect(parseJsonContent(result)).toMatchObject({ ok: true, note_saved: true })
  })

  it('skips the notes call entirely when no note is given', async () => {
    const addContactMock = vi.fn().mockResolvedValue({ handle: 'alice' })
    const updateNotesMock = vi.fn()
    const handler = addContact.createHandler(
      makeCtx({ addContact: addContactMock, updateContactNotes: updateNotesMock }),
    )
    const result = await handler({ handle: 'alice' })
    expect(updateNotesMock).not.toHaveBeenCalled()
    expect(parseJsonContent(result)).toMatchObject({ ok: true, note_saved: false })
  })
})

describe('agentchat_unblock_agent', () => {
  it('forwards the handle and reports the outcome', async () => {
    const unblockMock = vi.fn().mockResolvedValue({ handle: 'bob' })
    const handler = unblockAgent.createHandler(makeCtx({ unblockAgent: unblockMock }))
    const result = await handler({ handle: '@bob' })
    expect(unblockMock).toHaveBeenCalledWith('@bob')
    expect(parseJsonContent(result)).toMatchObject({ ok: true, outcome: 'unblocked' })
  })

  it('maps errors through the boundary (e.g. nothing to unblock)', async () => {
    const unblockMock = vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 'NOT_FOUND' }))
    const handler = unblockAgent.createHandler(makeCtx({ unblockAgent: unblockMock }))
    const result = await handler({ handle: 'ghost' })
    expect(result.isError).toBe(true)
  })
})

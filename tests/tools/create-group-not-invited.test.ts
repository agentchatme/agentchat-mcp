import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import * as addContact from '../../src/tools/add-contact.js'
import * as createGroup from '../../src/tools/create-group.js'
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

const GROUP = {
  id: 'grp_1',
  name: 'g',
  description: null,
  avatar_url: null,
  created_by: 'test',
  settings: { who_can_invite: 'admin' },
  member_count: 1,
  created_at: 'now',
  last_message_at: null,
  members: [],
  your_role: 'admin',
}

describe('create_group not_invited accounting', () => {
  it('surfaces handles the server silently dropped from add_results', async () => {
    // Server behavior: per-handle invite failures are swallowed and the
    // handle simply vanishes from add_results.
    const mock = vi.fn().mockResolvedValue({
      group: GROUP,
      add_results: [{ handle: 'alice', outcome: 'invited', invite_id: 'inv_1' }],
    })
    const handler = createGroup.createHandler(makeCtx({ createGroup: mock }))
    const result = await handler({ name: 'g', member_handles: ['@alice', '@allce-typo'] })
    expect(parseJsonContent(result)).toMatchObject({
      ok: true,
      invites: [{ handle: 'alice' }],
      not_invited: ['allce-typo'],
    })
  })

  it('reports empty not_invited when everyone was reported on', async () => {
    const mock = vi.fn().mockResolvedValue({
      group: GROUP,
      add_results: [{ handle: 'alice', outcome: 'invited', invite_id: 'inv_1' }],
    })
    const handler = createGroup.createHandler(makeCtx({ createGroup: mock }))
    const result = await handler({ name: 'g', member_handles: ['alice'] })
    expect(parseJsonContent(result)).toMatchObject({ not_invited: [] })
  })
})

describe('add_contact partial-failure honesty', () => {
  it('reports ok with note_saved:false + warning when the note write fails after the add', async () => {
    const addMock = vi.fn().mockResolvedValue({ handle: 'alice' })
    const noteMock = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'RATE_LIMITED' }))
    const handler = addContact.createHandler(
      makeCtx({ addContact: addMock, updateContactNotes: noteMock }),
    )
    const result = await handler({ handle: 'alice', note: 'x' })
    expect(result.isError).toBeFalsy()
    expect(parseJsonContent(result)).toMatchObject({
      ok: true,
      note_saved: false,
      warning: expect.stringContaining('contact was added'),
    })
  })
})

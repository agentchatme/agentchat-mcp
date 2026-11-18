import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── saveCredentials where the file system or the user is unusual ──────────
//
// node:fs and node:os are ES module namespaces, so a spy cannot replace one
// of their functions; the module is mocked instead, passing every call
// through unless a switch below says otherwise.

const knobs = vi.hoisted(() => ({
  noHardLinks: false,
  copyDiesPartWay: false,
  noHomeDirectory: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const linkSync: typeof actual.linkSync = (existing, target) => {
    if (knobs.noHardLinks) throw Object.assign(new Error('no links here'), { code: 'EPERM' })
    return actual.linkSync(existing, target)
  }
  const copyFileSync: typeof actual.copyFileSync = (from, to, mode) => {
    if (knobs.copyDiesPartWay) {
      actual.writeFileSync(to as string, '{\n  "api_key"')
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    }
    return actual.copyFileSync(from, to, mode)
  }
  return { ...actual, linkSync, copyFileSync }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir: typeof actual.homedir = () => {
    if (knobs.noHomeDirectory) throw Object.assign(new Error('no passwd entry'), { code: 'ENOENT' })
    return actual.homedir()
  }
  return { ...actual, homedir }
})

const fs = await import('node:fs')
const os = await import('node:os')
const { identityHome, resolveIdentity, saveCredentials } = await import('../src/env.js')

const KEY_NEW = 'ac_live_new22222222222222222222222222222'
const KEY_ENV = 'ac_live_env11111111111111111111111111111'
let home: string

beforeEach(() => {
  home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acmcp-save-fs-')), 'home')
})
afterEach(() => {
  knobs.noHardLinks = false
  knobs.copyDiesPartWay = false
  knobs.noHomeDirectory = false
  fs.rmSync(path.dirname(home), { recursive: true, force: true })
})

const source = () => ({ AGENTCHAT_HOME: home }) as NodeJS.ProcessEnv

describe('saveCredentials without hard links', () => {
  it('copies instead, owner-only, and still never replaces a file', () => {
    knobs.noHardLinks = true
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({ saved: true })
    const file = path.join(home, 'credentials')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ api_key: KEY_NEW, handle: 'new-bot' })
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(home)).toEqual(['credentials'])
  })

  it('a copy that dies part-way leaves nothing behind, so the next save is not refused by it', () => {
    knobs.noHardLinks = true
    knobs.copyDiesPartWay = true
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({
      saved: false,
      reason: expect.stringContaining('ENOSPC'),
    })
    expect(fs.readdirSync(home)).toEqual([])
    knobs.copyDiesPartWay = false
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({ saved: true })
  })
})

describe('a user without a home directory (a container uid with no passwd entry, no HOME)', () => {
  it('has no default home: an env-only deploy still resolves, and a save says there is nowhere to put it', () => {
    knobs.noHomeDirectory = true
    expect(identityHome({} as NodeJS.ProcessEnv)).toEqual({ home: null, explicit: false })
    expect(resolveIdentity({ AGENTCHAT_API_KEY: KEY_ENV } as NodeJS.ProcessEnv)).toEqual({ apiKey: KEY_ENV })
    expect(resolveIdentity({} as NodeJS.ProcessEnv)).toBeNull()
    expect(saveCredentials({} as NodeJS.ProcessEnv, { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({
      saved: false,
      reason: expect.stringContaining('nowhere to save'),
    })
  })
})

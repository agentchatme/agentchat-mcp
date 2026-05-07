import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_VERSION } from '../src/version.js'

describe('PACKAGE_VERSION', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(PACKAGE_VERSION).toBe(pkg.version)
  })
})

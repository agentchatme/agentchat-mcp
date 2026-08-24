import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ─── Build determinism (publish-blocking) ──────────────────────────────────
//
// tsup 8.x runs array configs in PARALLEL (Promise.all): a `clean: true` on
// either config races the other config's dist writes, and a publish could
// nondeterministically ship without dist/lib.* — the package's entire
// library surface. The fix: the build script wipes dist ONCE before tsup
// starts, and both configs set clean:false.
//
// This suite proves determinism the blunt way: five full consecutive
// builds, asserting the COMPLETE artifact set (bin + library, all formats,
// both declaration flavors) after every single run.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_ARTIFACTS = [
  'dist/index.js',
  'dist/index.cjs',
  'dist/lib.js',
  'dist/lib.cjs',
  'dist/lib.d.ts',
  'dist/lib.d.cts',
]

describe('build artifacts (5x loop — clean-race regression)', () => {
  it('emits the full artifact set on every one of 5 consecutive builds', () => {
    const shebang = '#!/usr/bin/env node'
    for (let run = 1; run <= 5; run += 1) {
      execSync('pnpm run build', { cwd: ROOT, stdio: 'pipe' })

      for (const rel of REQUIRED_ARTIFACTS) {
        const file = path.join(ROOT, rel)
        expect(fs.existsSync(file), `run ${run}: missing ${rel}`).toBe(true)
        expect(
          fs.statSync(file).size,
          `run ${run}: ${rel} exists but is empty`,
        ).toBeGreaterThan(0)
      }

      const indexJs = fs.readFileSync(path.join(ROOT, 'dist/index.js'), 'utf-8')
      const indexCjs = fs.readFileSync(path.join(ROOT, 'dist/index.cjs'), 'utf-8')
      expect(
        indexJs.startsWith(shebang),
        `run ${run}: dist/index.js lost its shebang`,
      ).toBe(true)
      expect(
        indexCjs.startsWith(shebang),
        `run ${run}: dist/index.cjs lost its shebang`,
      ).toBe(true)

      // The library entry must stay import-safe: no shebang, no auto-boot.
      const libJs = fs.readFileSync(path.join(ROOT, 'dist/lib.js'), 'utf-8')
      expect(
        libJs.startsWith('#!'),
        `run ${run}: dist/lib.js must not carry a shebang`,
      ).toBe(false)
    }
  }, 600_000)
})

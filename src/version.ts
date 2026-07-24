/**
 * Single source of truth for the package version string at runtime.
 *
 * Hand-edited rather than `import * from '../package.json'` so the bundled
 * artifact does not require `resolveJsonModule` + filesystem access at
 * startup. Pinned against `package.json` by `tests/version.test.ts`, which
 * fails CI if either drifts.
 */
export const PACKAGE_VERSION = '0.1.111'

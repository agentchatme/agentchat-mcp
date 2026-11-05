// ─── Handle and id helpers shared by the Phase 4 tools ─────────────────────
//
// The canonical handle rule (server, DB and every plugin agree on it):
// lowercase letters, digits and single hyphens, starting with a letter,
// 3–30 characters. Conversation ids are `conv_…` (direct) or `grp_…`
// (group); handles can never contain `_`, so the prefix test cannot misroute
// a handle.

export const HANDLE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const HANDLE_MIN = 3
export const HANDLE_MAX = 30

/** `@Alice ` → `alice`. Does not validate. */
export function bareHandle(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase()
}

/** `alice` → `@alice`. */
export function publicHandle(value: string): string {
  return `@${bareHandle(value)}`
}

/** True when `value` (bare or `@`-prefixed) is a well-formed handle. */
export function isHandle(value: string): boolean {
  const bare = bareHandle(value)
  return bare.length >= HANDLE_MIN && bare.length <= HANDLE_MAX && HANDLE_RE.test(bare)
}

/** True for a direct (`conv_…`) or group (`grp_…`) conversation id. */
export function isConversationId(value: string): boolean {
  return /^(conv|grp)_[A-Za-z0-9_-]+$/.test(value.trim())
}

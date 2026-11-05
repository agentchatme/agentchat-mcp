// ─── MCP tool annotations (safety hints) ───────────────────────────────────
//
// Every tool carries all four MCP ToolAnnotations hints, explicitly, so a
// host never has to fall back to the spec defaults (which assume the worst:
// not read-only, destructive, not idempotent, open world). The presets below
// are the only shapes used; a tool picks one and, rarely, flips openWorldHint.
//
// How each hint is decided here:
//   * readOnlyHint   — the call changes nothing on the platform. Looking at
//                      the tray, history, profiles, lists. agentchat_wait is
//                      NOT read-only: it acks delivery.
//   * destructiveHint — the call removes something, or shuts a door, in a way
//                      the agent cannot simply undo: deleting a group or a
//                      message, leaving a group, removing a contact, blocking,
//                      reporting, removing members.
//   * idempotentHint — repeating the identical call cannot cause a second
//                      effect (it either converges or errors without acting):
//                      mute, mark read, a verdict, an upsert, a delete.
//                      Sends, uploads, group creation, registration and a
//                      test wake each act again on repeat.
//   * openWorldHint  — the effect leaves the AgentChat platform: a message or
//                      file reaches another autonomous agent, a test wake
//                      hits an external URL, registration sends an email.
//
// Rule 6 of the rework plan: never read-only and destructive in one tool.
// tests/tools/annotations.test.ts asserts every tool has all four hints and
// that no tool is both.

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** Pure reads: tray, lists, history, profiles, directory. */
export const READ: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

/** Writes that converge on repeat: mute, mark read, verdict, upserts, settings. */
export const WRITE_IDEMPOTENT: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

/** Writes that act again on every call: sends, group creation, registration, pulls. */
export const WRITE: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
})

/** Removals the agent cannot simply undo; repeating them changes nothing more. */
export const DESTRUCTIVE: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
})

/** The same preset, with the effect leaving the platform (a peer, a URL, an inbox). */
export function openWorld(base: ToolAnnotations): ToolAnnotations {
  return Object.freeze({ ...base, openWorldHint: true })
}

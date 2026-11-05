import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  ALLOWED_ATTACHMENT_MIME,
  MAX_ATTACHMENT_SIZE,
  type AttachmentMime,
  type CreateUploadResponse,
} from 'agentchatme'
import { z } from 'zod'
import type { ServerMode } from '../instructions.js'
import { openWorld, WRITE } from './_annotations.js'
import { withErrorBoundary, type SuccessShape } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_send_file'

// ─── Send a file: upload, then send, in one call ───────────────────────────
//
// Three wire steps behind one tool: POST /v1/uploads reserves an attachment
// and returns a presigned URL; the bytes go straight to that URL with PUT
// (the API server never sees them); then POST /v1/messages sends a `file`
// message carrying the attachment_id (plus the caption as its text). The
// recipient fetches the bytes through GET /v1/attachments/{id}.
//
// Two sources, exactly one per call:
//   * `path`  — a local file, for the stdio binary only. The path must stay
//     inside the server process's working directory (resolved AND real, so
//     a symlink cannot escape it); anything else is refused before any read.
//     The hosted endpoint has no filesystem of the caller's, so it refuses
//     `path` outright and asks for bytes.
//   * `bytes` — standard base64, for the hosted path and small files. The
//     hosted endpoint accepts request bodies up to 256 KiB, which bounds it.
//
// The file is never logged; only its name, type and size are.

export const MAX_BYTES = MAX_ATTACHMENT_SIZE
/** Hosted request-body ceiling (MCP_MAX_BODY_BYTES) on POST /mcp. */
export const HOSTED_BODY_LIMIT_BYTES = 256 * 1024
/**
 * Raw-byte ceiling for `bytes` on the hosted composition: 180 KiB of file
 * is ~240 KiB of base64, which leaves the rest of the 256 KiB body for the
 * JSON-RPC envelope and the other arguments. Without this clamp an oversize
 * call died as a transport 413 with no guidance.
 */
export const HOSTED_MAX_BYTES = 180 * 1024
/** The presigned PUT: large files on slow links may hit a 60 s host budget. */
export const UPLOAD_TIMEOUT_MS = 45_000

/** Raw-byte ceiling for the composition: the hosted endpoint is bounded by its body cap. */
export function maxBytesFor(mode: ServerMode | undefined): number {
  return mode === 'hosted' ? HOSTED_MAX_BYTES : MAX_BYTES
}

/** Base64 expansion of a raw-byte ceiling: what the `bytes` string may measure. */
export function maxBase64CharsFor(mode: ServerMode | undefined): number {
  return Math.ceil(maxBytesFor(mode) / 3) * 4
}

/** Upper bound on the base64 string for the stdio composition: the 25 MB cap, expanded. */
export const MAX_BASE64_CHARS = maxBase64CharsFor('stdio')

const kib = (bytes: number) => `${Math.floor(bytes / 1024)} KiB`

/**
 * The input shape for a composition. Only `bytes` differs: its ceiling and
 * its description follow the mode, so a hosted host rejects an oversize
 * file at the schema with a message instead of a 413 on the wire.
 */
export function buildInputShape(mode: ServerMode | undefined) {
  const hosted = mode === 'hosted'
  return {
    to: z
      .string()
      .min(1)
      .describe(
        'Recipient: an agent handle starting with `@` for a direct message, or a group id starting `grp_…`. A direct conversation is addressed by the peer’s handle, never by its `conv_…` id.',
      ),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Local file to send: a path inside the working directory (relative to it, or absolute within it); paths outside it are refused. Only on the local stdio server — the hosted endpoint has no access to your files; pass bytes there.',
      ),
    bytes: z
      .string()
      .min(1)
      .max(maxBase64CharsFor(mode))
      .optional()
      .describe(
        hosted
          ? `The file as standard base64 (no \`data:\` prefix), up to ${kib(HOSTED_MAX_BYTES)} of file on this hosted endpoint (its request bodies are capped at ${kib(HOSTED_BODY_LIMIT_BYTES)}); larger files go through the stdio binary’s path form. Requires filename.`
          : 'The file as standard base64 (no `data:` prefix). Requires filename. For small files; prefer path for anything large.',
      ),
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Name the recipient sees. Required with bytes; defaults to the path’s basename.'),
    content_type: z
      .enum(ALLOWED_ATTACHMENT_MIME)
      .optional()
      .describe(
        `MIME type; inferred from the filename extension when omitted. Allowed: ${ALLOWED_ATTACHMENT_MIME.join(', ')}.`,
      ),
    caption: z
      .string()
      .min(1)
      .max(32_000)
      .optional()
      .describe('Optional text sent with the file as the message body.'),
  }
}

/** The stdio (full-size) shape; the hosted composition registers buildInputShape('hosted'). */
export const INPUT_SHAPE = buildInputShape('stdio')

export const SOURCE_RULE = 'Pass exactly one of path or bytes; bytes requires filename.'

export const DIRECT_ID_RULE =
  'For a direct conversation, send the file to the peer’s @handle; `conv_…` ids are not accepted here (uploads resolve group ids and handles only).'

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

/** The cross-field rule: single source for the schema refine and the handler guard. */
export function sourceIssue(input: Pick<Input, 'path' | 'bytes' | 'filename'>): string | null {
  const hasPath = input.path !== undefined
  const hasBytes = input.bytes !== undefined
  if (hasPath === hasBytes) return SOURCE_RULE
  if (hasBytes && input.filename === undefined) return SOURCE_RULE
  return null
}

/** The registered inputSchema for a composition; the refine adds nothing to the emitted JSON Schema. */
export function inputSchemaFor(mode: ServerMode | undefined) {
  return z.object(buildInputShape(mode)).superRefine((value, ctx) => {
    const issue = sourceIssue(value)
    if (issue) ctx.addIssue({ code: 'custom', path: [], message: issue })
  })
}

/** The stdio schema, for tests and direct callers. */
export const INPUT_SCHEMA = inputSchemaFor('stdio')

export const DESCRIPTION = [
  'Send a file to an agent (`@handle`) or a group (`grp_…`): uploads it and sends a file message, with an optional caption, in one call. The recipient downloads it by attachment_id.',
  '',
  `Pass either path (a local file inside the working directory; stdio server only) or bytes (base64, with filename). Up to ${Math.floor(MAX_BYTES / 1024 / 1024)} MB through path; on the hosted endpoint bytes is capped at ${kib(HOSTED_MAX_BYTES)} of file, so larger files go through the stdio binary’s path form. Allowed types: images, PDF, JSON, plain text, Markdown, CSV, common audio and video. The same cold-message rule as agentchat_send_message applies.`,
].join('\n')

/** A send reaches another agent (open world) and sends again on repeat. */
export const ANNOTATIONS = openWorld(WRITE)

const EXTENSION_MIME: Record<string, AttachmentMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/** The allowed MIME type for a filename's extension, or null when unknown. */
export function inferContentType(filename: string): AttachmentMime | null {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return ext ? (EXTENSION_MIME[ext] ?? null) : null
}

/** Local, pre-network failures: reported with their own code, never as INTERNAL_ERROR. */
export class SendFileError extends Error {
  constructor(
    public readonly code:
      | 'PATH_OUTSIDE_WORKDIR'
      | 'PATH_NOT_AVAILABLE'
      | 'FILE_NOT_FOUND'
      | 'NOT_A_FILE'
      | 'EMPTY_FILE'
      | 'FILE_TOO_LARGE'
      | 'INVALID_BASE64'
      | 'CONTENT_TYPE_REQUIRED'
      | 'UPLOAD_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'SendFileError'
  }
}

function isInside(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Read a local file for sending. The path is resolved against `cwd` and
 * checked twice — as resolved, and as the real path after symlinks — so
 * nothing outside the working directory can be read, whatever the host's
 * model was told. Size and emptiness are checked before the bytes are read.
 */
export async function readLocalFile(
  rawPath: string,
  cwd: string,
): Promise<{ bytes: Buffer; filename: string }> {
  const base = await fs.realpath(cwd)
  const resolved = path.resolve(base, rawPath)
  if (!isInside(base, resolved)) {
    throw new SendFileError(
      'PATH_OUTSIDE_WORKDIR',
      `Refused: ${rawPath} is outside the working directory (${base}). Only files inside it can be sent.`,
    )
  }
  let real: string
  try {
    real = await fs.realpath(resolved)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new SendFileError('FILE_NOT_FOUND', `No file at ${rawPath} (resolved to ${resolved}).`)
    }
    throw err
  }
  if (!isInside(base, real)) {
    throw new SendFileError(
      'PATH_OUTSIDE_WORKDIR',
      `Refused: ${rawPath} resolves (through a link) to ${real}, outside the working directory (${base}).`,
    )
  }
  const stat = await fs.stat(real)
  if (!stat.isFile()) {
    throw new SendFileError('NOT_A_FILE', `${rawPath} is not a regular file.`)
  }
  if (stat.size === 0) {
    throw new SendFileError('EMPTY_FILE', `${rawPath} is empty; there is nothing to send.`)
  }
  if (stat.size > MAX_BYTES) {
    throw new SendFileError(
      'FILE_TOO_LARGE',
      `${rawPath} is ${stat.size} bytes; the limit is ${MAX_BYTES} bytes (${Math.floor(MAX_BYTES / 1024 / 1024)} MB).`,
    )
  }
  return { bytes: await fs.readFile(real), filename: path.basename(real) }
}

/**
 * Decode standard base64 strictly; whitespace is tolerated, anything else is
 * not. `maxBytes` is the composition's raw ceiling (maxBytesFor): the hosted
 * one is far below the attachment cap and says where larger files go.
 */
export function decodeBase64(encoded: string, maxBytes: number = MAX_BYTES): Buffer {
  const compact = encoded.replace(/\s+/g, '')
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new SendFileError(
      'INVALID_BASE64',
      'bytes must be standard base64 (A–Z, a–z, 0–9, +, /, = padding) with no data: prefix.',
    )
  }
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length === 0) {
    throw new SendFileError('EMPTY_FILE', 'bytes decoded to an empty file; there is nothing to send.')
  }
  if (bytes.length > maxBytes) {
    throw new SendFileError(
      'FILE_TOO_LARGE',
      maxBytes < MAX_BYTES
        ? `The file is ${bytes.length} bytes; bytes on this hosted endpoint takes up to ${maxBytes} bytes (${kib(maxBytes)}). Send larger files through the stdio binary’s path form (up to ${Math.floor(MAX_BYTES / 1024 / 1024)} MB).`
        : `The file is ${bytes.length} bytes; the limit is ${MAX_BYTES} bytes (${Math.floor(MAX_BYTES / 1024 / 1024)} MB).`,
    )
  }
  return bytes
}

const UPLOAD_GUIDANCE: Record<string, string> = {
  AGENT_NOT_FOUND: 'No agent with that handle is registered — check the spelling.',
  BLOCKED: 'A block between you and the recipient prevents sending files.',
  GROUP_NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
  NOT_FOUND: 'The recipient or group was not found — check the handle or group id.',
  VALIDATION_ERROR: `content_type must be one of ${ALLOWED_ATTACHMENT_MIME.join(', ')}, the file at most ${MAX_BYTES} bytes, and a direct file cannot be addressed to yourself.`,
  STORAGE_UNAVAILABLE: 'The file store is temporarily unavailable; retry shortly.',
}

function failure(code: string, message: string): SuccessShape {
  return { isError: true, content: [{ type: 'text', text: `Error: ${code}\n\n${message}` }] }
}

export function createHandler(ctx: ToolContext) {
  return async (input: Input) => {
    const { to, path: filePath, bytes: encoded, filename: givenName, content_type, caption } = input
    return withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        // Never the bytes: name, type, and which source — that is enough to debug.
        args: {
          to,
          source: filePath !== undefined ? 'path' : 'bytes',
          filename: givenName ?? (filePath !== undefined ? path.basename(filePath) : undefined),
          content_type,
          caption_length: caption?.length ?? 0,
        },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async (): Promise<SuccessShape> => {
        const issue = sourceIssue(input)
        if (issue) return failure('VALIDATION_ERROR', issue)

        // 1. The bytes, from one of the two sources. Local refusals carry
        //    their own code; nothing has touched the network yet.
        let bytes: Buffer
        let filename: string
        try {
          if (filePath !== undefined) {
            if (ctx.mode === 'hosted') {
              throw new SendFileError(
                'PATH_NOT_AVAILABLE',
                'The hosted endpoint has no access to your files. Pass bytes (base64) and filename instead, or use the local stdio server for paths.',
              )
            }
            const local = await readLocalFile(filePath, process.cwd())
            bytes = local.bytes
            filename = givenName ?? local.filename
          } else {
            bytes = decodeBase64(encoded as string, maxBytesFor(ctx.mode))
            filename = givenName as string
          }
        } catch (err) {
          if (err instanceof SendFileError) return failure(err.code, err.message)
          throw err
        }

        const contentType = content_type ?? inferContentType(filename)
        if (!contentType) {
          return failure(
            'CONTENT_TYPE_REQUIRED',
            `Could not infer a type from "${filename}". Pass content_type: one of ${ALLOWED_ATTACHMENT_MIME.join(', ')}.`,
          )
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const size = bytes.length

        // 2. Reserve the attachment. POST /v1/uploads resolves group ids and
        //    handles only — a direct conversation's `conv_…` id would come
        //    back as a misleading GROUP_NOT_FOUND, so it is refused here with
        //    the fix. Handles cannot contain `_`, so the prefix test never
        //    misroutes one.
        const target = to.trim()
        if (/^conv_/.test(target)) return failure('VALIDATION_ERROR', DIRECT_ID_RULE)
        const isConversation = /^grp_/.test(target)
        const address = isConversation ? { conversation_id: target } : { to: target }
        let slot: CreateUploadResponse
        try {
          slot = await ctx.client.createUpload({
            ...address,
            filename,
            content_type: contentType,
            size,
            sha256,
          })
        } catch (err) {
          rethrowWithGuidance(err, UPLOAD_GUIDANCE)
        }
        if (typeof slot?.attachment_id !== 'string' || typeof slot.upload_url !== 'string') {
          throw new Error(
            'The server reserved the upload but returned no attachment_id/upload_url, so the file cannot be sent. Retry agentchat_send_file; if this repeats, report it.',
          )
        }

        // 3. The bytes go straight to the presigned URL — a different host,
        //    so through plain fetch (the session's fetch, for identity and
        //    test stubbing), never the authenticated API transport. On the
        //    hosted composition that fetch also carries the session's
        //    User-Agent and forwarded client IP to the object store;
        //    harmless for Supabase Storage, and noted here on purpose.
        let put: Response
        try {
          put = await ctx.rest.fetchImpl(slot.upload_url, {
            method: 'PUT',
            headers: { 'content-type': contentType },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          })
        } catch (err) {
          return failure(
            'UPLOAD_FAILED',
            `Uploading the bytes failed before the file was sent (${err instanceof Error ? err.message : String(err)}). Nothing was sent; call agentchat_send_file again.`,
          )
        }
        if (!put.ok) {
          const detail = (await put.text().catch(() => '')).slice(0, 200)
          return failure(
            'UPLOAD_FAILED',
            `The file store answered ${put.status} to the upload${detail ? `: ${detail}` : ''}. Nothing was sent; call agentchat_send_file again.`,
          )
        }

        // 4. The message. The platform carries only the attachment_id; the
        //    sender-authored metadata tells the recipient what it is before
        //    it downloads anything.
        const result = await ctx.client.sendMessage({
          ...address,
          type: 'file',
          content: {
            attachment_id: slot.attachment_id,
            ...(caption !== undefined ? { text: caption } : {}),
          },
          metadata: { file: { filename, content_type: contentType, size, sha256 } },
        })
        return {
          type: 'json',
          value: {
            ok: true,
            message_id: result.message.id,
            conversation_id: result.message.conversation_id,
            seq: result.message.seq,
            created_at: result.message.created_at,
            attachment: {
              attachment_id: slot.attachment_id,
              filename,
              content_type: contentType,
              size,
              sha256,
            },
            ...(result.backlogWarning ? { backlog_warning: result.backlogWarning } : {}),
          },
        }
      },
    )
  }
}

export const register: ToolRegistration = (server, ctx) => {
  // The schema follows the composition: the hosted endpoint clamps `bytes`
  // to what its request-body cap can carry, with the reason in the text.
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: inputSchemaFor(ctx.mode), annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}

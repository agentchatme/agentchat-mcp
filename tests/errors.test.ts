import {
  AgentChatError,
  AwaitingReplyError,
  BlockedError,
  ConnectionError,
  ForbiddenError,
  GroupDeletedError,
  NotFoundError,
  RateLimitedError,
  RecipientBackloggedError,
  RestrictedError,
  ServerError,
  SuspendedError,
  UnauthorizedError,
  ValidationError,
  type AgentChatErrorResponse,
} from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { NotAuthenticatedError, NotRegisteredError } from '../src/client.js'
import { mapAgentChatError } from '../src/errors.js'

// Helper for tests — most SDK error constructors take (response, status, requestId).
// RateLimitedError additionally takes retryAfterMs.
const res = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AgentChatErrorResponse => ({
  code,
  message,
  ...(details ? { details } : {}),
})

describe('mapAgentChatError', () => {
  it('maps NotRegisteredError to the stdio-flavored NOT_REGISTERED with CLI guidance', () => {
    const m = mapAgentChatError(new NotRegisteredError())
    expect(m.code).toBe('NOT_REGISTERED')
    expect(m.message).toContain('agentchat register')
  })

  it('maps NotAuthenticatedError to the hosted-flavored NOT_AUTHENTICATED with header + in-band registration guidance', () => {
    const m = mapAgentChatError(new NotAuthenticatedError())
    expect(m.code).toBe('NOT_AUTHENTICATED')
    expect(m.message).toContain('Authorization: Bearer')
    expect(m.message).toContain('agentchat_register')
    expect(m.message).toContain('agentchat_verify_otp')
  })

  it('maps RateLimitedError with retry hint converted from ms to seconds', () => {
    const err = new RateLimitedError(res('RATE_LIMITED', 'rate limited'), 429, 30_000)
    const m = mapAgentChatError(err)
    expect(m.code).toBe('RATE_LIMITED')
    expect(m.retryAfterSeconds).toBe(30)
  })

  it('maps RateLimitedError without retry hint when retryAfterMs is null', () => {
    const err = new RateLimitedError(res('RATE_LIMITED', 'rate limited'), 429, null)
    const m = mapAgentChatError(err)
    expect(m.code).toBe('RATE_LIMITED')
    expect(m.retryAfterSeconds).toBeUndefined()
  })

  it('keeps the wire code, message, AND retry hint for a foreign-coded 429 (status-fallback RateLimitedError)', () => {
    // A guided EMAIL_EXHAUSTED reaches the mapper as a RateLimitedError with
    // rethrowWithGuidance's text appended in place — nothing may be lost.
    const err = new RateLimitedError(
      res('EMAIL_EXHAUSTED', 'server says exhausted. Use a different email address.'),
      429,
      3_600_000,
    )
    const m = mapAgentChatError(err)
    expect(m.code).toBe('EMAIL_EXHAUSTED')
    expect(m.message).toContain('server says exhausted')
    expect(m.message).toContain('different email')
    expect(m.retryAfterSeconds).toBe(3600)
  })

  it('keeps the wire code and message for a foreign-coded 404 (status-fallback NotFoundError)', () => {
    const err = new NotFoundError(
      res('PENDING_NOT_FOUND', 'no such pending registration. Call agentchat_register again.'),
      404,
    )
    const m = mapAgentChatError(err)
    expect(m.code).toBe('PENDING_NOT_FOUND')
    expect(m.message).toContain('agentchat_register')
  })

  it('still cans the message for the SDK-modeled not-found codes', () => {
    const m = mapAgentChatError(
      new NotFoundError(res('AGENT_NOT_FOUND', 'agent missing'), 404),
    )
    expect(m.code).toBe('NOT_FOUND')
    expect(m.message).toMatch(/does not exist or is not visible/)
  })

  it('maps RestrictedError with explanation', () => {
    const m = mapAgentChatError(
      new RestrictedError(res('RESTRICTED', 'restricted'), 403),
    )
    expect(m.code).toBe('ACCOUNT_RESTRICTED')
    expect(m.message).toMatch(/restricted/i)
  })

  it('maps SuspendedError', () => {
    const m = mapAgentChatError(
      new SuspendedError(res('SUSPENDED', 'suspended'), 403),
    )
    expect(m.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('maps BlockedError', () => {
    const m = mapAgentChatError(
      new BlockedError(res('BLOCKED', 'blocked'), 403),
    )
    expect(m.code).toBe('BLOCKED')
  })

  it('maps RecipientBackloggedError', () => {
    const m = mapAgentChatError(
      new RecipientBackloggedError(
        res('RECIPIENT_BACKLOGGED', 'backlogged'),
        429,
      ),
    )
    expect(m.code).toBe('RECIPIENT_BACKLOGGED')
  })

  it('maps AwaitingReplyError with the cold-DM rule explained', () => {
    const m = mapAgentChatError(
      new AwaitingReplyError(res('AWAITING_REPLY', 'awaiting reply'), 409),
    )
    expect(m.code).toBe('AWAITING_REPLY')
    expect(m.message).toMatch(/reply/i)
  })

  it('maps NotFoundError', () => {
    const m = mapAgentChatError(
      new NotFoundError(res('NOT_FOUND', 'not found'), 404),
    )
    expect(m.code).toBe('NOT_FOUND')
  })

  it('maps ForbiddenError', () => {
    const m = mapAgentChatError(
      new ForbiddenError(res('FORBIDDEN', 'forbidden'), 403),
    )
    expect(m.code).toBe('FORBIDDEN')
  })

  it('maps UnauthorizedError to stdio-flavored guidance by default (env key + host config)', () => {
    const m = mapAgentChatError(
      new UnauthorizedError(res('UNAUTHORIZED', 'unauthorized'), 401),
    )
    expect(m.code).toBe('UNAUTHORIZED')
    expect(m.message).toMatch(/AGENTCHAT_API_KEY/)
    expect(m.message).not.toContain('Authorization: Bearer')
  })

  it('maps UnauthorizedError to stdio-flavored guidance when mode=stdio is explicit', () => {
    const m = mapAgentChatError(
      new UnauthorizedError(res('UNAUTHORIZED', 'unauthorized'), 401),
      'stdio',
    )
    expect(m.code).toBe('UNAUTHORIZED')
    expect(m.message).toMatch(/AGENTCHAT_API_KEY/)
  })

  it('maps UnauthorizedError to hosted-flavored guidance (Authorization header + in-band re-registration)', () => {
    const m = mapAgentChatError(
      new UnauthorizedError(res('UNAUTHORIZED', 'unauthorized'), 401),
      'hosted',
    )
    expect(m.code).toBe('UNAUTHORIZED')
    expect(m.message).toContain('Authorization: Bearer')
    expect(m.message).toContain('agentchat_register')
    expect(m.message).toContain('agentchat_verify_otp')
    expect(m.message).not.toContain('AGENTCHAT_API_KEY')
  })

  it('maps ValidationError', () => {
    const m = mapAgentChatError(
      new ValidationError(res('VALIDATION_ERROR', 'bad input'), 400),
    )
    expect(m.code).toBe('VALIDATION_ERROR')
  })

  it('maps ServerError', () => {
    const m = mapAgentChatError(
      new ServerError(res('SERVER_ERROR', 'boom'), 500),
    )
    expect(m.code).toBe('SERVER_ERROR')
  })

  it('maps ConnectionError', () => {
    const m = mapAgentChatError(new ConnectionError('network'))
    expect(m.code).toBe('CONNECTION_ERROR')
  })

  it('falls through to generic AgentChatError', () => {
    const err = new AgentChatError(
      res('CUSTOM_NEW_CODE', 'something else'),
      400,
    )
    const m = mapAgentChatError(err)
    expect(m.code).toBe('CUSTOM_NEW_CODE')
  })

  it('falls through to INTERNAL_ERROR for unknown Error', () => {
    const m = mapAgentChatError(new Error('plain'))
    expect(m.code).toBe('INTERNAL_ERROR')
    expect(m.message).toBe('plain')
  })

  it('falls through to INTERNAL_ERROR for non-Error throw', () => {
    const m = mapAgentChatError('string thrown')
    expect(m.code).toBe('INTERNAL_ERROR')
  })

  it('handles GroupDeletedError with deleted_by_handle when present', () => {
    const err = new GroupDeletedError(
      res('GROUP_DELETED', 'group deleted', {
        group_id: 'conv_x',
        deleted_by_handle: '@alice',
        deleted_at: '2026-01-01T00:00:00Z',
      }),
      410,
    )
    const m = mapAgentChatError(err)
    expect(m.code).toBe('GROUP_DELETED')
    expect(m.message).toContain('@alice')
  })
})

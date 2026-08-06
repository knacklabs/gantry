import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_DELETED_COPY,
  ATTACHMENT_NOT_VISIBLE_COPY,
  ATTACHMENT_RATE_LIMITED_COPY,
  ATTACHMENT_TIMEOUT_COPY,
  ATTACHMENT_TOO_LARGE_COPY,
  ATTACHMENT_TRANSPORT_COPY,
  ATTACHMENT_UNREACHABLE_COPY,
  attachmentPermissionScopeCopy,
  classifyAndLogAttachmentFailure,
  type AttachmentFailureEvidence,
} from '@core/application/attachments/attachment-failure.js';
import { logger } from '@core/infrastructure/logging/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function classify(evidence: AttachmentFailureEvidence) {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return classifyAndLogAttachmentFailure({
    evidence,
    provider: 'slack',
    providerAccountId: 'slack-default',
    conversationJid: 'sl:C123',
    attachmentId: 'attachment-1',
    elapsedMs: 25,
  });
}

describe('attachment failure classification and copy', () => {
  it.each([
    [
      {
        kind: 'provider_unreachable',
        reason: 'missing_scope',
        scope: 'files:read',
      },
      'permission_scope',
      attachmentPermissionScopeCopy('files:read'),
    ],
    [
      { kind: 'provider_unreachable', reason: 'not_visible' },
      'not_visible',
      ATTACHMENT_NOT_VISIBLE_COPY,
    ],
    [{ kind: 'deleted' }, 'deleted', ATTACHMENT_DELETED_COPY],
    [{ kind: 'too_large' }, 'too_large', ATTACHMENT_TOO_LARGE_COPY],
    [
      { kind: 'provider_unreachable', reason: 'rate_limit' },
      'rate_limited',
      ATTACHMENT_RATE_LIMITED_COPY,
    ],
    [{ kind: 'timeout' }, 'timeout', ATTACHMENT_TIMEOUT_COPY],
    [
      { kind: 'provider_unreachable', reason: 'network' },
      'transport',
      ATTACHMENT_TRANSPORT_COPY,
    ],
  ] as const)('maps evidence to %s copy', (evidence, cause, content) => {
    expect(classify(evidence)).toEqual({ cause, content });
  });

  it.each([
    { kind: 'provider_unreachable', reason: 'incapable' },
    { kind: 'provider_unreachable', reason: 'not_found' },
    { kind: 'provider_unreachable', reason: 'unknown' },
    { kind: 'unexpected' },
  ] as const)('keeps conservative evidence on the legacy copy', (evidence) => {
    expect(classify(evidence)).toEqual({
      cause: 'unknown',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
  });

  it('does not turn another provider bare authorization evidence into a scope claim', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(
      classifyAndLogAttachmentFailure({
        evidence: { kind: 'provider_unreachable', reason: 'auth' },
        provider: 'discord',
        providerAccountId: 'discord-default',
        conversationJid: 'dc:C123',
        attachmentId: 'attachment-1',
        elapsedMs: 25,
      }),
    ).toEqual({
      cause: 'unknown',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
  });

  it('keeps all named cause sentences distinct', () => {
    expect(
      new Set([
        attachmentPermissionScopeCopy('files:read'),
        ATTACHMENT_NOT_VISIBLE_COPY,
        ATTACHMENT_DELETED_COPY,
        ATTACHMENT_TOO_LARGE_COPY,
        ATTACHMENT_RATE_LIMITED_COPY,
        ATTACHMENT_TIMEOUT_COPY,
        ATTACHMENT_TRANSPORT_COPY,
        ATTACHMENT_UNREACHABLE_COPY,
      ]).size,
    ).toBe(8);
  });

  it('emits only the allowlisted log fields', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    classifyAndLogAttachmentFailure({
      evidence: {
        kind: 'provider_unreachable',
        reason: 'rate_limit',
        providerStatus: 429,
      },
      provider: 'slack',
      providerAccountId: 'slack-default',
      conversationJid: 'sl:C123',
      attachmentId: 'attachment-1',
      elapsedMs: 24.6,
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        cause: 'rate_limited',
        provider: 'slack',
        providerAccountId: 'slack-default',
        conversationJid: 'sl:C123',
        attachmentId: 'attachment-1',
        providerStatus: 429,
        elapsedMs: 25,
      },
      'Attachment unavailable',
    );
  });
});

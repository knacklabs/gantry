import type { HistoricalAttachmentUnreachableReason } from '../../domain/ports/historical-attachment-fetcher.js';
import { logger, redactString } from '../../infrastructure/logging/logger.js';

const ATTACHMENT_ERROR_MESSAGE_MAX_LENGTH = 300;

export const ATTACHMENT_NOT_FOUND_COPY =
  "I couldn't find that attachment in this conversation.";
export const ATTACHMENT_DELETED_COPY =
  'That file was deleted from the channel.';
export const ATTACHMENT_TOO_LARGE_COPY =
  "That file is larger than 50 MiB, so I can't open it.";
export const ATTACHMENT_UNREACHABLE_COPY =
  "I can't get that file from the channel right now.";
export const ATTACHMENT_PERMISSION_SCOPE_COPY =
  "I can't read files in this workspace yet because the Slack app needs the files:read permission; ask an admin to reinstall Gantry.";
export const ATTACHMENT_NOT_VISIBLE_COPY =
  "I can't read that file because it isn't visible to Gantry; share it in a channel Gantry can access.";
export const ATTACHMENT_RATE_LIMITED_COPY =
  'The channel is limiting file requests right now; try opening the attachment again in a few minutes.';
export const ATTACHMENT_TIMEOUT_COPY =
  'The file took too long to download; try opening it again.';
export const ATTACHMENT_TRANSPORT_COPY =
  "I couldn't reach the channel to download that file; try opening it again.";

export type AttachmentFailureCause =
  | 'permission_scope'
  | 'not_visible'
  | 'deleted'
  | 'too_large'
  | 'rate_limited'
  | 'timeout'
  | 'transport'
  | 'unknown';

export type AttachmentFailureEvidence =
  | {
      kind: 'provider_unreachable';
      reason: HistoricalAttachmentUnreachableReason;
      providerStatus?: number;
    }
  | { kind: 'deleted' }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'unexpected' };

export type AttachmentFailureErrorSummary = {
  errorName: string;
  errorCode?: string;
  errorMessage?: string;
};

export function classifyAndLogAttachmentFailure(input: {
  evidence: AttachmentFailureEvidence;
  provider: string;
  providerAccountId: string;
  conversationJid: string;
  attachmentId: string;
  elapsedMs: number;
  errorSummary?: AttachmentFailureErrorSummary;
  workspaceFolder?: string;
}): { cause: AttachmentFailureCause; content: string } {
  const cause = classifyAttachmentFailure(input.evidence, input.provider);
  const errorSummary = input.errorSummary
    ? sanitizeAttachmentFailureErrorSummary(input.errorSummary)
    : undefined;
  logger.warn(
    {
      cause,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      conversationJid: input.conversationJid,
      attachmentId: input.attachmentId,
      ...(input.evidence.kind === 'provider_unreachable' &&
      input.evidence.providerStatus !== undefined
        ? { providerStatus: input.evidence.providerStatus }
        : {}),
      elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
      ...(errorSummary ?? {}),
      ...(input.workspaceFolder
        ? {
            workspaceFolder: sanitizeErrorSummaryText(
              input.workspaceFolder,
              128,
            ),
          }
        : {}),
    },
    'Attachment unavailable',
  );
  return { cause, content: ATTACHMENT_FAILURE_COPY[cause] };
}

export function summarizeAttachmentFailureError(
  error: unknown,
): AttachmentFailureErrorSummary {
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  const errorName = sanitizeErrorSummaryText(
    error instanceof Error ? error.name : typeof error,
    80,
  );
  const code = record?.code;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;
  return {
    errorName,
    ...(typeof code === 'string' || typeof code === 'number'
      ? { errorCode: sanitizeErrorSummaryText(String(code), 80) }
      : {}),
    ...(message
      ? {
          errorMessage: sanitizeErrorSummaryText(
            message,
            ATTACHMENT_ERROR_MESSAGE_MAX_LENGTH,
          ),
        }
      : {}),
  };
}

function sanitizeAttachmentFailureErrorSummary(
  summary: AttachmentFailureErrorSummary,
): AttachmentFailureErrorSummary {
  return {
    errorName: sanitizeErrorSummaryText(summary.errorName, 80),
    ...(summary.errorCode
      ? { errorCode: sanitizeErrorSummaryText(summary.errorCode, 80) }
      : {}),
    ...(summary.errorMessage
      ? {
          errorMessage: sanitizeErrorSummaryText(
            summary.errorMessage,
            ATTACHMENT_ERROR_MESSAGE_MAX_LENGTH,
          ),
        }
      : {}),
  };
}

function sanitizeErrorSummaryText(value: string, maxLength: number): string {
  const redacted = redactString(value)
    .replace(/\bhttps?:\/\/[^\s'"<>]+/giu, '[REDACTED_URL]')
    .replace(
      /(?:[A-Za-z]:\\(?:[^\\\s'"]+\\)*[^\\\s'"]+|\/(?:[^/\s'"]+\/)+[^/\s'"]+)/gu,
      '[REDACTED_PATH]',
    )
    .replace(
      /\b(file[_-]?(?:content|bytes)|body|response|cause)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\{.*?\}|\[[^\]]*\]|[^,;]+)/giu,
      '$1=[REDACTED]',
    );
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength - 3)}...`;
}

function classifyAttachmentFailure(
  evidence: AttachmentFailureEvidence,
  provider: string,
): AttachmentFailureCause {
  if (evidence.kind === 'deleted') return 'deleted';
  if (evidence.kind === 'too_large') return 'too_large';
  if (evidence.kind === 'timeout') return 'timeout';
  if (evidence.kind === 'unexpected') return 'unknown';

  switch (evidence.reason) {
    case 'auth':
      return provider === 'slack' ? 'permission_scope' : 'unknown';
    case 'not_visible':
      return 'not_visible';
    case 'rate_limit':
      return 'rate_limited';
    case 'network':
      return 'transport';
    case 'incapable':
    case 'not_found':
    case 'unknown':
      return 'unknown';
  }
}

const ATTACHMENT_FAILURE_COPY: Record<AttachmentFailureCause, string> = {
  permission_scope: ATTACHMENT_PERMISSION_SCOPE_COPY,
  not_visible: ATTACHMENT_NOT_VISIBLE_COPY,
  deleted: ATTACHMENT_DELETED_COPY,
  too_large: ATTACHMENT_TOO_LARGE_COPY,
  rate_limited: ATTACHMENT_RATE_LIMITED_COPY,
  timeout: ATTACHMENT_TIMEOUT_COPY,
  transport: ATTACHMENT_TRANSPORT_COPY,
  unknown: ATTACHMENT_UNREACHABLE_COPY,
};

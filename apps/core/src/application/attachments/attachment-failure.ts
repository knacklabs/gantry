import type { HistoricalAttachmentUnreachableEvidence } from '../../domain/ports/historical-attachment-fetcher.js';
import { logger } from '../../infrastructure/logging/logger.js';

export const ATTACHMENT_NOT_FOUND_COPY =
  "I couldn't find that attachment in this conversation.";
export const ATTACHMENT_DELETED_COPY =
  'That file was deleted from the channel.';
export const ATTACHMENT_TOO_LARGE_COPY =
  "That file is larger than 50 MiB, so I can't open it.";
export const ATTACHMENT_UNREACHABLE_COPY =
  "I can't get that file from the channel right now.";
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
  | ({
      kind: 'provider_unreachable';
      providerStatus?: number;
    } & HistoricalAttachmentUnreachableEvidence)
  | { kind: 'deleted' }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'unexpected' };

export function classifyAndLogAttachmentFailure(input: {
  evidence: AttachmentFailureEvidence;
  provider: string;
  providerAccountId: string;
  conversationJid: string;
  attachmentId: string;
  elapsedMs: number;
}): { cause: AttachmentFailureCause; content: string } {
  const cause = classifyAttachmentFailure(input.evidence);
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
    },
    'Attachment unavailable',
  );
  return { cause, content: attachmentFailureCopy(cause, input.evidence) };
}

function classifyAttachmentFailure(
  evidence: AttachmentFailureEvidence,
): AttachmentFailureCause {
  if (evidence.kind === 'deleted') return 'deleted';
  if (evidence.kind === 'too_large') return 'too_large';
  if (evidence.kind === 'timeout') return 'timeout';
  if (evidence.kind === 'unexpected') return 'unknown';

  switch (evidence.reason) {
    case 'missing_scope':
      return 'permission_scope';
    case 'auth':
      return 'unknown';
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

export function attachmentPermissionScopeCopy(scope: string): string {
  return `I can't read files in this workspace yet because the channel app needs the ${scope} permission; ask an admin to reinstall Gantry.`;
}

function attachmentFailureCopy(
  cause: AttachmentFailureCause,
  evidence: AttachmentFailureEvidence,
): string {
  if (
    cause === 'permission_scope' &&
    evidence.kind === 'provider_unreachable' &&
    evidence.reason === 'missing_scope'
  ) {
    return attachmentPermissionScopeCopy(evidence.scope);
  }
  if (cause === 'permission_scope') return ATTACHMENT_UNREACHABLE_COPY;
  return ATTACHMENT_FAILURE_COPY[cause];
}

const ATTACHMENT_FAILURE_COPY: Record<
  Exclude<AttachmentFailureCause, 'permission_scope'>,
  string
> = {
  not_visible: ATTACHMENT_NOT_VISIBLE_COPY,
  deleted: ATTACHMENT_DELETED_COPY,
  too_large: ATTACHMENT_TOO_LARGE_COPY,
  rate_limited: ATTACHMENT_RATE_LIMITED_COPY,
  timeout: ATTACHMENT_TIMEOUT_COPY,
  transport: ATTACHMENT_TRANSPORT_COPY,
  unknown: ATTACHMENT_UNREACHABLE_COPY,
};

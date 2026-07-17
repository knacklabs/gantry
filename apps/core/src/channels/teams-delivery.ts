import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../domain/types.js';
import { PartialMessageDeliveryError } from '../domain/messages/partial-delivery.js';
import type { TeamsSdkClient } from './teams.js';

const TEAMS_SOFT_MESSAGE_BYTES = 78 * 1024;
export const TEAMS_HARD_MESSAGE_BYTES = 80 * 1024;
const TEAMS_413_RETRY_MAX_BYTES = 64 * 1024;

function splitTeamsTextByCodeUnits(
  text: string,
  maxCodeUnits: number,
): string[] {
  if (!text) return [];
  if (text.length <= maxCodeUnits) return [text];
  const parts: string[] = [];
  let partStart = 0;
  let partLength = 0;
  for (const codePoint of text) {
    const codePointLength = codePoint.length;
    if (partLength > 0 && partLength + codePointLength > maxCodeUnits) {
      parts.push(text.slice(partStart, partStart + partLength));
      partStart += partLength;
      partLength = 0;
    }
    partLength += codePointLength;
  }
  if (partStart < text.length) {
    parts.push(text.slice(partStart));
  }
  return parts;
}

export function splitTeamsTextByByteBudget(
  text: string,
  maxBytes: number,
): string[] {
  if (!text) return [];
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes > 0 && currentBytes + charBytes > maxBytes) {
      parts.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) parts.push(current);
  return parts;
}

function splitTeamsPartFor413Retry(text: string): string[] {
  if (!text) return [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= 1) return [];
  const retryBudget = Math.min(
    TEAMS_413_RETRY_MAX_BYTES,
    Math.max(1024, Math.floor(bytes / 2)),
  );
  const parts = splitTeamsTextByByteBudget(text, retryBudget).filter(Boolean);
  return parts.length >= 2 ? parts : [];
}

function isTeamsPayloadTooLarge(err: unknown): boolean {
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  if (
    candidate.status === 413 ||
    candidate.statusCode === 413 ||
    candidate.code === 413 ||
    candidate.response?.status === 413
  ) {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    /413|payload too large|request entity too large/i.test(candidate.message)
  );
}

export async function sendTeamsTextMessage(
  sdkClient: TeamsSdkClient,
  conversationId: string,
  text: string,
  options: MessageSendOptions = {},
  shouldContinue: () => boolean = () => true,
): Promise<MessageDeliveryResult | void> {
  const initialParts = splitTeamsTextByByteBudget(
    text,
    TEAMS_SOFT_MESSAGE_BYTES,
  )
    .flatMap((part) =>
      splitTeamsTextByCodeUnits(part, TEAMS_HARD_MESSAGE_BYTES),
    )
    .filter((part) => part.length > 0);
  if (initialParts.length === 0) return {};

  const queue = [...initialParts];
  const warnings: string[] = [];
  if (queue.length > 1) {
    warnings.push(
      `teams.message.chunked:${queue.length}:${TEAMS_SOFT_MESSAGE_BYTES}`,
    );
  }

  const externalMessageIds: string[] = [];
  let deliveredParts = 0;
  let index = 0;
  while (index < queue.length) {
    if (!shouldContinue()) break;
    const part = queue[index];
    try {
      const sent = await sdkClient.sendMessage({
        conversationId,
        text: part,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      });
      if (sent.externalMessageId) {
        externalMessageIds.push(sent.externalMessageId);
      }
      deliveredParts += 1;
      index += 1;
    } catch (err) {
      if (isTeamsPayloadTooLarge(err)) {
        const split = splitTeamsPartFor413Retry(part);
        if (split.length >= 2) {
          queue.splice(index, 1, ...split);
          warnings.push('teams.payload_413_split_retry');
          continue;
        }
      }
      if (deliveredParts > 0) {
        const unsentTail = queue.slice(index).join('');
        const partial = new PartialMessageDeliveryError({
          cause: err,
          deliveredChunks: deliveredParts,
          name: 'PartialTeamsDeliveryError',
          message: `Teams message partially delivered (${deliveredParts}/${queue.length} parts)`,
          totalChunks: queue.length,
        });
        Object.assign(partial, {
          provider: 'teams',
          deliveredParts,
          totalParts: queue.length,
          externalMessageIds,
          ...(unsentTail.trim()
            ? {
                retryTail: {
                  canonicalText: unsentTail,
                  providerPayload: {
                    provider: 'teams',
                    conversationId,
                    ...(options.threadId ? { threadId: options.threadId } : {}),
                  },
                },
              }
            : {}),
          warnings: [...warnings, 'teams.partial_delivery'],
        });
        throw partial;
      }
      throw err;
    }
  }

  return {
    ...(externalMessageIds[0]
      ? { externalMessageId: externalMessageIds[0] }
      : {}),
    ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
    deliveredParts,
    totalParts: queue.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

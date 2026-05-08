const MAX_ID_LENGTH = 256;
const MAX_WARNING_LENGTH = 160;
const MAX_LIST_ITEMS = 20;
const MAX_PART_COUNT = 10_000;
const SAFE_WARNING_CODE = /^[a-z0-9]+(?:[._][a-z0-9]+)+(?::[0-9]{1,6})*$/;
const SECRET_LIKE_WARNING_TEXT =
  /\b(token|secret|authorization|bearer|api[_-]?key|password)\b|sk-[a-z0-9_-]{8,}|xox[a-z]-[a-z0-9-]{8,}/i;

export interface RetryTailProviderPayload {
  provider?: string;
  channelId?: string;
  chatId?: string;
  chatJid?: string;
  conversationId?: string;
  conversationJid?: string;
  jid?: string;
  threadId?: string;
  externalMessageId?: string;
  externalMessageIds?: string[];
  deliveredParts?: number;
  totalParts?: number;
  warnings?: string[];
  fallbackArtifactId?: string;
}

export function sanitizeRetryTailProviderPayload(
  payload: unknown,
): RetryTailProviderPayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const sanitized: RetryTailProviderPayload = {};

  const provider = readString(source.provider, { maxLength: 32 });
  if (provider) sanitized.provider = provider;
  const channelId = readString(source.channelId, { maxLength: MAX_ID_LENGTH });
  if (channelId) sanitized.channelId = channelId;
  const chatId = readString(source.chatId, { maxLength: MAX_ID_LENGTH });
  if (chatId) sanitized.chatId = chatId;
  const chatJid = readString(source.chatJid, { maxLength: MAX_ID_LENGTH });
  if (chatJid) sanitized.chatJid = chatJid;
  const conversationId = readString(source.conversationId, {
    maxLength: MAX_ID_LENGTH,
  });
  if (conversationId) sanitized.conversationId = conversationId;
  const conversationJid = readString(source.conversationJid, {
    maxLength: MAX_ID_LENGTH,
  });
  if (conversationJid) sanitized.conversationJid = conversationJid;
  const jid = readString(source.jid, { maxLength: MAX_ID_LENGTH });
  if (jid) sanitized.jid = jid;
  const threadId = readString(source.threadId, { maxLength: MAX_ID_LENGTH });
  if (threadId) sanitized.threadId = threadId;
  const externalMessageId = readString(source.externalMessageId, {
    maxLength: MAX_ID_LENGTH,
  });
  if (externalMessageId) sanitized.externalMessageId = externalMessageId;
  const externalMessageIds = readStringArray(source.externalMessageIds, {
    maxLength: MAX_ID_LENGTH,
    maxItems: MAX_LIST_ITEMS,
  });
  if (externalMessageIds.length > 0) {
    sanitized.externalMessageIds = externalMessageIds;
  }
  const warnings = readWarningCodeArray(source.warnings, {
    maxLength: MAX_WARNING_LENGTH,
    maxItems: MAX_LIST_ITEMS,
  });
  if (warnings.length > 0) sanitized.warnings = warnings;
  const fallbackArtifactId = readString(source.fallbackArtifactId, {
    maxLength: MAX_ID_LENGTH,
  });
  if (fallbackArtifactId) sanitized.fallbackArtifactId = fallbackArtifactId;
  const deliveredParts = readInt(source.deliveredParts);
  if (deliveredParts !== undefined) sanitized.deliveredParts = deliveredParts;
  const totalParts = readInt(source.totalParts);
  if (totalParts !== undefined) sanitized.totalParts = totalParts;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function readString(
  value: unknown,
  options: {
    maxLength: number;
  },
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, options.maxLength);
}

function readStringArray(
  value: unknown,
  options: {
    maxLength: number;
    maxItems: number;
  },
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    const parsed = readString(entry, { maxLength: options.maxLength });
    if (!parsed) continue;
    result.push(parsed);
    if (result.length >= options.maxItems) break;
  }
  return result;
}

function readWarningCodeArray(
  value: unknown,
  options: {
    maxLength: number;
    maxItems: number;
  },
): string[] {
  const entries = readStringArray(value, options);
  return entries.filter(
    (entry) =>
      SAFE_WARNING_CODE.test(entry) && !SECRET_LIKE_WARNING_TEXT.test(entry),
  );
}

function readInt(value: unknown): number | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  const num = value as number;
  if (num < 0 || num > MAX_PART_COUNT) return undefined;
  return num;
}

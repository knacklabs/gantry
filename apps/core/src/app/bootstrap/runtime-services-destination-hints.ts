const CANONICAL_CONVERSATION_PREFIX = 'conversation:';
const CONTROL_CONVERSATION_PREFIX = 'control:';

export const RETRY_TAIL_PROFILE_ID = 'runtime.retry_tail_suffix.v1';
export const LIVE_SEND_PROFILE_ID = 'runtime.live_send.v1';
const PREFIX_SL = 'sl:';
const PREFIX_TG = 'tg:';

export function canonicalConversationIdForJid(
  jid: string,
  providerAccountId?: string,
): string {
  const appSession = parseAppSessionJid(jid);
  if (appSession) {
    return `${CONTROL_CONVERSATION_PREFIX}${appSession.appId}:conversation:${appSession.externalConversationId}`;
  }
  if (providerAccountId) {
    return `${CANONICAL_CONVERSATION_PREFIX}${providerAccountId}:${jid}`;
  }
  return `${CANONICAL_CONVERSATION_PREFIX}${jid}`;
}

export function resolveDurableOutboundTarget(input: {
  defaultAppId: string;
  jid: string;
  providerAccountId?: string;
}): { appId: string; conversationId: string } {
  const appSession = parseAppSessionJid(input.jid);
  if (appSession) {
    return {
      appId: appSession.appId,
      conversationId: canonicalConversationIdForJid(input.jid),
    };
  }
  return {
    appId: input.defaultAppId,
    conversationId: canonicalConversationIdForJid(
      input.jid,
      input.providerAccountId,
    ),
  };
}

export function canonicalThreadIdFor(input: {
  jid: string;
  threadId?: string;
  providerAccountId?: string;
}): string | undefined {
  const normalized = input.threadId?.trim();
  if (!normalized) return undefined;
  return input.providerAccountId && !parseAppSessionJid(input.jid)
    ? `thread:${input.providerAccountId}:${input.jid}:${normalized}`
    : `thread:${input.jid}:${normalized}`;
}

function providerJidFromCanonicalConversationId(
  rawConversationId: unknown,
  canonicalConversationJid?: string,
): string | null {
  if (typeof rawConversationId !== 'string') return null;
  const conversationId = rawConversationId.trim();
  if (!conversationId.startsWith(CANONICAL_CONVERSATION_PREFIX)) return null;
  const providerJid = conversationId
    .slice(CANONICAL_CONVERSATION_PREFIX.length)
    .trim();
  const expectedJid = canonicalConversationJid?.trim();
  if (expectedJid) {
    if (providerJid === expectedJid) return expectedJid;
    const expectedStart = providerJid.lastIndexOf(`:${expectedJid}`);
    if (expectedStart >= 0) {
      return providerJid.slice(expectedStart + 1).trim() || null;
    }
  }
  return providerJid || null;
}

function providerJidFromDestinationHint(
  rawHint: unknown,
  canonicalConversationJid?: string,
): {
  providerJid?: string;
  malformedCanonicalHint: boolean;
} {
  if (typeof rawHint !== 'string') return { malformedCanonicalHint: false };
  const hint = rawHint.trim();
  if (!hint) return { malformedCanonicalHint: false };
  if (hint.startsWith(CANONICAL_CONVERSATION_PREFIX)) {
    const providerJid = providerJidFromCanonicalConversationId(
      hint,
      canonicalConversationJid,
    );
    if (!providerJid) {
      return { malformedCanonicalHint: true };
    }
    return { providerJid, malformedCanonicalHint: false };
  }
  return { providerJid: hint, malformedCanonicalHint: false };
}

export function normalizeDestinationHintAgainstCanonical(
  rawHint: unknown,
  canonicalConversationJid: string,
): {
  providerJid?: string;
  malformedCanonicalHint: boolean;
} {
  const parsed = providerJidFromDestinationHint(
    rawHint,
    canonicalConversationJid,
  );
  if (parsed.malformedCanonicalHint || !parsed.providerJid) {
    return parsed;
  }
  const normalizedHint = parsed.providerJid.trim();
  if (!normalizedHint) return { malformedCanonicalHint: false };
  const separator = canonicalConversationJid.indexOf(':');
  if (separator <= 0) {
    return { providerJid: normalizedHint, malformedCanonicalHint: false };
  }
  const canonicalProviderPrefix = canonicalConversationJid.slice(
    0,
    separator + 1,
  );
  if (normalizedHint.startsWith(canonicalProviderPrefix)) {
    return { providerJid: normalizedHint, malformedCanonicalHint: false };
  }
  if (normalizedHint.includes(':')) {
    const segmentBeforeColon = normalizedHint
      .slice(0, normalizedHint.indexOf(':'))
      .trim();
    if (!/^[a-z][a-z0-9_-]*$/i.test(segmentBeforeColon)) {
      return {
        providerJid: `${canonicalProviderPrefix}${normalizedHint}`,
        malformedCanonicalHint: false,
      };
    }
    return { providerJid: normalizedHint, malformedCanonicalHint: false };
  }
  return {
    providerJid: `${canonicalProviderPrefix}${normalizedHint}`,
    malformedCanonicalHint: false,
  };
}

export function sanitizeRetryTailProviderPayloadDestinationMetadata(
  providerPayload: unknown,
  canonicalConversationJid: string,
): Record<string, unknown> | undefined {
  if (
    !providerPayload ||
    typeof providerPayload !== 'object' ||
    Array.isArray(providerPayload)
  ) {
    return undefined;
  }
  const sanitized = { ...(providerPayload as Record<string, unknown>) };
  const canonicalRawDestinationId = rawConversationIdFromJid(
    canonicalConversationJid,
  );
  if (!canonicalRawDestinationId) return sanitized;

  if (canonicalConversationJid.startsWith(PREFIX_SL)) {
    sanitizeDestinationMetadataField({
      payload: sanitized,
      key: 'channelId',
      expectedRawValue: canonicalRawDestinationId,
      acceptedPrefix: PREFIX_SL,
    });
  } else if (canonicalConversationJid.startsWith(PREFIX_TG)) {
    sanitizeDestinationMetadataField({
      payload: sanitized,
      key: 'chatId',
      expectedRawValue: canonicalRawDestinationId,
      acceptedPrefix: PREFIX_TG,
    });
  }

  return sanitized;
}

export function sanitizeRetryTailForCanonicalDestination(
  retryTail:
    | {
        canonicalText: string;
        providerPayload?: unknown;
      }
    | undefined,
  canonicalConversationJid: string,
):
  | {
      canonicalText: string;
      providerPayload?: Record<string, unknown>;
    }
  | undefined {
  if (!retryTail) return undefined;
  const providerPayload = sanitizeRetryTailProviderPayloadDestinationMetadata(
    retryTail.providerPayload,
    canonicalConversationJid,
  );
  return {
    canonicalText: retryTail.canonicalText,
    ...(providerPayload !== undefined ? { providerPayload } : {}),
  };
}

function rawConversationIdFromJid(jid: string): string | null {
  const separator = jid.indexOf(':');
  if (separator <= 0) return null;
  const value = jid.slice(separator + 1).trim();
  return value || null;
}

function normalizeMetadataDestinationValue(
  value: string,
  acceptedPrefix: string,
): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(acceptedPrefix)) {
    return trimmed.slice(acceptedPrefix.length).trim();
  }
  return trimmed;
}

function sanitizeDestinationMetadataField(input: {
  payload: Record<string, unknown>;
  key: 'channelId' | 'chatId';
  expectedRawValue: string;
  acceptedPrefix: string;
}): void {
  const raw = input.payload[input.key];
  if (typeof raw !== 'string') return;
  const normalized = normalizeMetadataDestinationValue(
    raw,
    input.acceptedPrefix,
  );
  if (!normalized || normalized !== input.expectedRawValue) {
    delete input.payload[input.key];
    return;
  }
  input.payload[input.key] = input.expectedRawValue;
}

function parseAppSessionJid(
  jid: string,
): { appId: string; externalConversationId: string } | null {
  if (!jid.startsWith('app:')) return null;
  const rest = jid.slice('app:'.length);
  const delimiterIndex = rest.indexOf(':');
  if (delimiterIndex <= 0) return null;
  if (rest.indexOf(':', delimiterIndex + 1) !== -1) return null;
  const appId = rest.slice(0, delimiterIndex).trim();
  const externalConversationId = rest.slice(delimiterIndex + 1).trim();
  if (!appId || !externalConversationId) return null;
  return { appId, externalConversationId };
}

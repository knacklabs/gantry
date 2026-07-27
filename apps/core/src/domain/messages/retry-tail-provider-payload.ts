const MAX_ID_LENGTH = 256;
const MAX_WARNING_LENGTH = 160;
const MAX_LIST_ITEMS = 20;
const MAX_PART_COUNT = 10_000;
// Observer digest view caps. The view is a small top-N (schedule.maxInsights)
// with a fixed 4-affordance set per insight; these bound the persisted blob so
// a malformed/oversized one fails safe to text-only rather than bloating the row.
const MAX_DIGEST_INSIGHTS = 50;
const MAX_DIGEST_AFFORDANCES = 8;
const MAX_DIGEST_TITLE = 200;
const MAX_DIGEST_SUMMARY = 1_000;
const MAX_DIGEST_LABEL = 80;
const MAX_DIGEST_SHORT = 64;
// Mirrors ObserverFeedbackAction; kept literal here so the domain->messages dir
// stays leaf (no cross-dir import for four string constants).
const OBSERVER_FEEDBACK_ACTIONS = new Set([
  'resolve',
  'dismiss',
  'snooze',
  'less_like_this',
]);
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
  // Bounded, structurally-validated mirror of ObserverDigestMessageView so the
  // digest's native per-insight action buttons survive persist + recovery
  // dispatch (the recovery loop reads providerPayload.observerDigestView). Not
  // free-form provider content — every field is capped and the affordance action
  // is allowlisted; malformed input drops the field/element, never throws.
  observerDigestView?: SanitizedObserverDigestView;
}

export interface SanitizedObserverDigestView {
  localDay: string;
  recipient?: string;
  insights: SanitizedObserverDigestInsight[];
}

export interface SanitizedObserverDigestInsight {
  insightId: string;
  title?: string;
  summary?: string;
  type?: string;
  stateMarker?: string;
  affordances: SanitizedObserverFeedbackAffordance[];
}

export interface SanitizedObserverFeedbackAffordance {
  kind: 'observer_feedback';
  label: string;
  insightId: string;
  action: string;
  localDay: string;
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
  const observerDigestView = readObserverDigestView(source.observerDigestView);
  if (observerDigestView) sanitized.observerDigestView = observerDigestView;

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

function readObserverDigestView(
  value: unknown,
): SanitizedObserverDigestView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const localDay = readString(source.localDay, { maxLength: MAX_DIGEST_SHORT });
  // localDay is the digest's identity (it rides every callback token); without a
  // valid one the view can't render actionable buttons — fail safe to text-only.
  if (!localDay) return undefined;
  const view: SanitizedObserverDigestView = { localDay, insights: [] };
  const recipient = readString(source.recipient, { maxLength: MAX_ID_LENGTH });
  if (recipient) view.recipient = recipient;
  if (Array.isArray(source.insights)) {
    for (const entry of source.insights) {
      const insight = readObserverDigestInsight(entry, localDay);
      if (!insight) continue;
      view.insights.push(insight);
      if (view.insights.length >= MAX_DIGEST_INSIGHTS) break;
    }
  }
  return view;
}

function readObserverDigestInsight(
  value: unknown,
  viewLocalDay: string,
): SanitizedObserverDigestInsight | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const insightId = readString(source.insightId, { maxLength: MAX_ID_LENGTH });
  if (!insightId) return undefined;
  const insight: SanitizedObserverDigestInsight = {
    insightId,
    affordances: [],
  };
  const title = readString(source.title, { maxLength: MAX_DIGEST_TITLE });
  if (title) insight.title = title;
  const summary = readString(source.summary, { maxLength: MAX_DIGEST_SUMMARY });
  if (summary) insight.summary = summary;
  const type = readString(source.type, { maxLength: MAX_DIGEST_SHORT });
  if (type) insight.type = type;
  const stateMarker = readString(source.stateMarker, {
    maxLength: MAX_DIGEST_SHORT,
  });
  if (stateMarker) insight.stateMarker = stateMarker;
  if (Array.isArray(source.affordances)) {
    for (const entry of source.affordances) {
      const affordance = readObserverFeedbackAffordance(
        entry,
        insightId,
        viewLocalDay,
      );
      if (!affordance) continue;
      insight.affordances.push(affordance);
      if (insight.affordances.length >= MAX_DIGEST_AFFORDANCES) break;
    }
  }
  return insight;
}

function readObserverFeedbackAffordance(
  value: unknown,
  parentInsightId: string,
  viewLocalDay: string,
): SanitizedObserverFeedbackAffordance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (source.kind !== 'observer_feedback') return undefined;
  const label = readString(source.label, { maxLength: MAX_DIGEST_LABEL });
  const insightId = readString(source.insightId, { maxLength: MAX_ID_LENGTH });
  const action = readString(source.action, { maxLength: MAX_DIGEST_SHORT });
  const localDay = readString(source.localDay, { maxLength: MAX_DIGEST_SHORT });
  if (
    !label ||
    !insightId ||
    !action ||
    !localDay ||
    !OBSERVER_FEEDBACK_ACTIONS.has(action) ||
    // A button drives a callback that mutates (insightId, localDay). Bind it to
    // its container so a corrupted payload can't render a button beside insight
    // A whose click settles insight B (or a different digest day). Mismatch
    // drops just this affordance — fail safe, never throw.
    insightId !== parentInsightId ||
    localDay !== viewLocalDay
  ) {
    return undefined;
  }
  return { kind: 'observer_feedback', label, insightId, action, localDay };
}

function readInt(value: unknown): number | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  const num = value as number;
  if (num < 0 || num > MAX_PART_COUNT) return undefined;
  return num;
}

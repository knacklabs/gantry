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

export interface SanitizedBrainReviewView {
  reviewId: string;
  action: string;
  headline: string;
  details: string[];
  buttons: Array<{ label: string; decision: 'approve' | 'reject' }>;
}

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
  // Host-generated structured card view (brain destructive-proposal review, T6).
  // Bounded passthrough so the Approve/Reject buttons survive durable persistence
  // and are re-rendered on recovery dispatch (the retry-tail allowlist otherwise
  // strips unknown keys). Not user/provider content, so it is not secret-scanned.
  brainReviewView?: SanitizedBrainReviewView;
  // Bounded, structurally-validated mirror of ObserverDigestMessageView so the
  // digest's native per-insight action buttons survive persist + recovery
  // dispatch (the recovery loop reads providerPayload.observerDigestView). Not
  // free-form provider content — every field is capped and the affordance action
  // is allowlisted; malformed input drops the field/element, never throws.
  observerDigestView?: SanitizedObserverDigestView;
  // Job-permission cards are durable, revision-bound delivery payloads. Keep
  // their bounded action contract so recovery dispatch can edit the living
  // card rather than degrading it to plain text.
  jobPermissionCard?: SanitizedJobPermissionCard;
}

export interface SanitizedJobPermissionCard {
  operation: 'send' | 'edit' | 'retire' | 'replace';
  providerMessageId?: string;
  actions: Array<{ token: string; label: string }>;
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
  const brainReviewView = readBrainReviewView(source.brainReviewView);
  if (brainReviewView) sanitized.brainReviewView = brainReviewView;
  const observerDigestView = readObserverDigestView(source.observerDigestView);
  if (observerDigestView) sanitized.observerDigestView = observerDigestView;
  const jobPermissionCard = readJobPermissionCard(source.jobPermissionCard);
  if (jobPermissionCard) sanitized.jobPermissionCard = jobPermissionCard;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

const MAX_CARD_TEXT = 1000;
const MAX_CARD_DETAILS = 10;
const MAX_CARD_BUTTONS = 4;
const MAX_JOB_PERMISSION_CARD_ACTIONS = 20;
const JOB_PERMISSION_ACTION_TOKEN =
  /^jp:[a-f0-9]{24}:[a-z0-9]+:[a-z0-9]+:[adrsn]$/;

function readJobPermissionCard(
  value: unknown,
): SanitizedJobPermissionCard | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const operation = source.operation;
  if (!['send', 'edit', 'retire', 'replace'].includes(String(operation))) {
    return undefined;
  }
  const providerMessageId = readString(source.providerMessageId, {
    maxLength: MAX_ID_LENGTH,
  });
  if ((operation === 'edit' || operation === 'retire') && !providerMessageId) {
    return undefined;
  }
  if (!Array.isArray(source.actions)) return undefined;
  const actions: SanitizedJobPermissionCard['actions'] = [];
  for (const value of source.actions.slice(
    0,
    MAX_JOB_PERMISSION_CARD_ACTIONS,
  )) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const action = value as Record<string, unknown>;
    const token = readString(action.token, { maxLength: 64 });
    const label = readString(action.label, { maxLength: 80 });
    if (!token || !JOB_PERMISSION_ACTION_TOKEN.test(token) || !label) {
      return undefined;
    }
    actions.push({ token, label });
  }
  return {
    operation: operation as SanitizedJobPermissionCard['operation'],
    ...(providerMessageId ? { providerMessageId } : {}),
    actions,
  };
}

// Bounded reader for the brain-review card view. Structural only — coerces each
// field to a length-capped string / small array; a malformed shape yields
// undefined (the send falls back to text), never throws.
function readBrainReviewView(
  value: unknown,
): SanitizedBrainReviewView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const reviewId = readString(source.reviewId, { maxLength: MAX_ID_LENGTH });
  const action = readString(source.action, { maxLength: 64 });
  const headline = readString(source.headline, { maxLength: MAX_CARD_TEXT });
  if (!reviewId || !action || !headline) return undefined;
  const details: string[] = [];
  if (Array.isArray(source.details)) {
    for (const entry of source.details.slice(0, MAX_CARD_DETAILS)) {
      const line = readString(entry, { maxLength: MAX_CARD_TEXT });
      if (line) details.push(line);
    }
  }
  const buttons: SanitizedBrainReviewView['buttons'] = [];
  if (Array.isArray(source.buttons)) {
    for (const entry of source.buttons.slice(0, MAX_CARD_BUTTONS)) {
      if (!entry || typeof entry !== 'object') continue;
      const button = entry as Record<string, unknown>;
      const label = readString(button.label, { maxLength: 75 });
      const decision = button.decision;
      if (label && (decision === 'approve' || decision === 'reject')) {
        buttons.push({ label, decision });
      }
    }
  }
  return { reviewId, action, headline, details, buttons };
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

// Identity-bearing fields (insightId, localDay) drive callback tokens, so the
// value must be VERBATIM: neither truncated nor trim-normalized. Normalizing
// " x " -> "x" could match a DIFFERENT insight's real id and settle the wrong
// target on click — the same risk truncation had. Reject (drop the owning
// element) if the RAW value is empty, non-string, over the max, or would change
// under trim; else return the ORIGINAL string. Display fields keep truncation
// via readString.
function readIdentity(
  value: unknown,
  options: {
    maxLength: number;
  },
): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value || value.length > options.maxLength || value !== value.trim()) {
    return undefined;
  }
  return value;
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
  const localDay = readIdentity(source.localDay, {
    maxLength: MAX_DIGEST_SHORT,
  });
  // localDay is the digest's identity (it rides every callback token); without a
  // valid one the view can't render actionable buttons — fail safe to text-only.
  if (!localDay) return undefined;
  const view: SanitizedObserverDigestView = { localDay, insights: [] };
  const recipient = readString(source.recipient, { maxLength: MAX_ID_LENGTH });
  if (recipient) view.recipient = recipient;
  if (Array.isArray(source.insights)) {
    // Bound entries INSPECTED, not just accepted: a malformed array of millions
    // of invalid entries must not be traversed in full (DoS on enqueue/recovery).
    for (const entry of source.insights.slice(0, MAX_DIGEST_INSIGHTS)) {
      const insight = readObserverDigestInsight(entry, localDay);
      if (insight) view.insights.push(insight);
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
  const insightId = readIdentity(source.insightId, {
    maxLength: MAX_ID_LENGTH,
  });
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
    // Bound entries INSPECTED (see insights loop): each insight can carry an
    // arbitrarily large invalid affordance array.
    for (const entry of source.affordances.slice(0, MAX_DIGEST_AFFORDANCES)) {
      const affordance = readObserverFeedbackAffordance(
        entry,
        insightId,
        viewLocalDay,
      );
      if (affordance) insight.affordances.push(affordance);
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
  const insightId = readIdentity(source.insightId, {
    maxLength: MAX_ID_LENGTH,
  });
  const action = readString(source.action, { maxLength: MAX_DIGEST_SHORT });
  const localDay = readIdentity(source.localDay, {
    maxLength: MAX_DIGEST_SHORT,
  });
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

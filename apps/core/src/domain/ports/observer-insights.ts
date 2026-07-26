import type { ObserverDigestMessageView } from '../observer-digest-view.js';

export const OBSERVER_INSIGHT_TYPES = [
  'commitment',
  'contradiction',
  'open_question',
  'stale_fact',
  'decision_without_owner',
  'duplicated_work',
  'repetition',
] as const;

export type ObserverInsightType = (typeof OBSERVER_INSIGHT_TYPES)[number];

export const OBSERVER_INSIGHT_STATES = [
  'pending',
  'claimed',
  'sent',
  'cooldown',
  'resolved',
  'dropped',
] as const;

export type ObserverInsightState = (typeof OBSERVER_INSIGHT_STATES)[number];

export type ObserverSubjectKey =
  | `msu_${string}`
  | `conversation:${string}`
  | 'observer:app';

export function isObserverSubjectKey(
  value: string,
): value is ObserverSubjectKey {
  if (/^msu_[a-f0-9]{32}$/.test(value) || value === 'observer:app') {
    return true;
  }
  if (!value.startsWith('conversation:')) return false;
  const conversationId = value.slice('conversation:'.length);
  return (
    conversationId.trim().length > 0 &&
    [...conversationId].every((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
  );
}

export interface ObserverInsightEvidenceRef {
  conversationId: string;
  messageId: string;
  ts: string;
  // Account-qualified provenance (added for digest freshness + permalinks).
  // Legacy rows persisted before this may omit these; consumers must fail
  // closed when the provider account or raw conversation jid is missing.
  providerAccountId?: string;
  conversationJid?: string;
  threadId?: string | null;
  permalink?: string | null;
}

export interface ProactiveInsight {
  id: string;
  appId: string;
  subject: ObserverSubjectKey;
  insightType: ObserverInsightType;
  title: string;
  summary: string;
  evidenceRefs: ObserverInsightEvidenceRef[];
  batchSnapshotAt: string;
  evidenceVersion: number;
  canonicalSignature: string;
  signatureEmbeddingRef: string | null;
  confidence: number;
  priorityScore: number;
  state: ObserverInsightState;
  cooldownUntil: string | null;
  resolvedAt: string | null;
  surfacedAt: string | null;
  recipient: string;
  deliveryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObserverInsightCreate {
  id: string;
  appId: string;
  subject: ObserverSubjectKey;
  insightType: ObserverInsightType;
  title: string;
  summary: string;
  evidenceRefs: ObserverInsightEvidenceRef[];
  batchSnapshotAt: string;
  evidenceVersion: number;
  canonicalSignature: string;
  signatureEmbeddingRef?: string | null;
  confidence: number;
  priorityScore: number;
  recipient: string;
  nowIso: string;
}

export interface ObserverDelivery {
  id: string;
  appId: string;
  recipient: string;
  localDay: string;
  createdAt: string;
}

export const OBSERVER_DELIVERY_STATES = [
  'reserved',
  'sent',
  'settled',
  'failed',
] as const;
export type ObserverDeliveryState = (typeof OBSERVER_DELIVERY_STATES)[number];

export interface ObserverDigestReservation {
  id: string;
  appId: string;
  recipient: string;
  localDay: string;
  state: ObserverDeliveryState;
  timezone: string | null;
  conversationJid: string | null;
  providerAccountId: string | null;
  threadId: string | null;
  renderedDigest: string | null;
  /** Provider-neutral, immutable digest view (ordered insights + their
   * `observer_feedback` affordances) persisted at reserve time so the buttons
   * survive a recovery/resend. Null on rows reserved before this was added. */
  renderedView: ObserverDigestMessageView | null;
  contentHash: string | null;
  outboundDeliveryId: string | null;
  reservedAt: string | null;
  sentAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface ObserverDigestClaimMembership {
  insightId: string;
  claimedAt: string;
  position: number;
}

export interface ObserverDigestReserveResult {
  reservation: ObserverDigestReservation;
  created: boolean;
}

// Read-only digest history row for the deliveries control surface: a reservation
// plus the count of insights it carried, without exposing the members or route.
export interface ObserverDigestDeliverySummary {
  id: string;
  localDay: string;
  state: ObserverDeliveryState;
  insightCount: number;
  reservedAt: string | null;
  sentAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface ObserverInsightCursor {
  updatedAt: string;
  pageId: string;
}

export type ObserverFeedbackAction =
  | 'resolve'
  | 'dismiss'
  | 'snooze'
  | 'less_like_this';

// A delivered insight plus the route it was delivered on, so the caller can
// authorize an owner action against the owner DM before applying it.
export interface ObserverOwnerActionInsight {
  insight: ProactiveInsight;
  conversationJid: string | null;
  providerAccountId: string | null;
  threadId: string | null;
}

export type ObserverOwnerActionOutcome = 'applied' | 'stale' | 'invalid';

export interface ObserverOwnerActionResult {
  outcome: ObserverOwnerActionOutcome;
  // Set when the idempotency key already existed: the click is a replay and
  // was a no-op (no re-count, no re-transition).
  already?: boolean;
  // less_like_this only: the type crossed the suppression threshold and its
  // suppressed_until window is now active.
  suppressedType?: boolean;
}

export interface ObserverInsightRepository {
  create(input: ObserverInsightCreate): Promise<ProactiveInsight>;
  listPendingForSubject(input: {
    appId: string;
    subject: ObserverSubjectKey;
    limit: number;
  }): Promise<ProactiveInsight[]>;
  list(input: {
    appId: string;
    subject?: ObserverSubjectKey;
    state?: ObserverInsightState;
    insightType?: ObserverInsightType;
    limit: number;
    before?: { createdAt: string; id: string };
  }): Promise<ProactiveInsight[]>;
  count(input: {
    appId: string;
    subject?: ObserverSubjectKey;
    state?: ObserverInsightState;
    insightType?: ObserverInsightType;
  }): Promise<number>;
  findBySignature(input: {
    appId: string;
    subject: ObserverSubjectKey;
    canonicalSignature: string;
  }): Promise<ProactiveInsight | null>;
  findHistoricalBySignature(input: {
    appId: string;
    subject: ObserverSubjectKey;
    canonicalSignature: string;
  }): Promise<ProactiveInsight | null>;
  findSemanticDuplicate(input: {
    appId: string;
    subject: ObserverSubjectKey;
    model: string;
    dimensions: number;
    embedding: number[];
    minSimilarity: number;
  }): Promise<{ insight: ProactiveInsight; similarity: number } | null>;
  transitionState(input: {
    id: string;
    from: ObserverInsightState;
    to: ObserverInsightState;
    nowIso: string;
    claimedAt?: string;
    cooldownUntil?: string | null;
    resolvedAt?: string | null;
  }): Promise<ProactiveInsight | null>;
  recoverStaleClaims(input: {
    appId: string;
    subject: ObserverSubjectKey;
    staleBeforeIso: string;
    nowIso: string;
  }): Promise<ProactiveInsight[]>;
  markDelivered(input: {
    id: string;
    deliveryId: string;
    surfacedAt: string;
    claimedAt: string;
    nowIso: string;
  }): Promise<ProactiveInsight | null>;
  recordDelivery(input: {
    id: string;
    appId: string;
    recipient: string;
    localDay: string;
    nowIso: string;
  }): Promise<ObserverDelivery>;
  // App-wide digest assembly (across all subjects for one recipient).
  claimPendingForDigest(input: {
    appId: string;
    recipient: string;
    limit: number;
    nowIso: string;
  }): Promise<ProactiveInsight[]>;
  // Read-only sibling of claimPendingForDigest: the same pending pool, same
  // order, but claims nothing. Backs the dry-run digest preview.
  listPendingForDigest(input: {
    appId: string;
    recipient: string;
    limit: number;
  }): Promise<ProactiveInsight[]>;
  // Read-only digest history for a recipient, newest-first, with member counts.
  listDigestDeliveries(input: {
    appId: string;
    recipient: string;
    limit: number;
  }): Promise<ObserverDigestDeliverySummary[]>;
  findDigestReservation(input: {
    appId: string;
    recipient: string;
    localDay: string;
  }): Promise<ObserverDigestReservation | null>;
  // All not-yet-settled reservations (reserved/sent) for a recipient across ANY
  // localDay, oldest-first, so a delivery stranded before local midnight is
  // still found and re-driven on the next day's tick.
  findUnsettledDigestReservations(input: {
    appId: string;
    recipient: string;
  }): Promise<ObserverDigestReservation[]>;
  reserveDigest(input: {
    id: string;
    appId: string;
    recipient: string;
    localDay: string;
    timezone: string;
    conversationJid: string;
    providerAccountId: string;
    threadId?: string | null;
    renderedDigest: string;
    renderedView?: ObserverDigestMessageView | null;
    contentHash: string;
    memberships: ObserverDigestClaimMembership[];
    nowIso: string;
  }): Promise<ObserverDigestReserveResult>;
  settleDigest(input: {
    deliveryId: string;
    outboundDeliveryId: string;
    cooldownUntil: string;
    nowIso: string;
  }): Promise<ObserverDigestReservation | null>;
  recoverStaleDigestClaims(input: {
    appId: string;
    staleBeforeIso: string;
    nowIso: string;
  }): Promise<ProactiveInsight[]>;
  // Owner-scoped (app_id + recipient) lookup of a single insight plus its
  // delivery route, for authorizing an owner action. Null when the insight is
  // not owned by this (app, recipient).
  findInsightForOwnerAction(input: {
    appId: string;
    recipient: string;
    insightId: string;
  }): Promise<ObserverOwnerActionInsight | null>;
  // Single atomic owner action on a delivered (cooldown) insight. Idempotent
  // per (insight, actor, action). Durations are caller-supplied parameters.
  applyOwnerAction(input: {
    appId: string;
    recipient: string;
    actorUserId: string;
    insightId: string;
    action: ObserverFeedbackAction;
    nowIso: string;
    snoozeMs: number;
    suppressMs: number;
    suppressThreshold: number;
  }): Promise<ObserverOwnerActionResult>;
  // Owner-scoped (app_id + recipient) insight types with an ACTIVE time-boxed
  // suppression (suppressed_until > nowIso). Expired suppressions are not
  // returned — their type resumes surfacing. Emission loads this once per run.
  listActiveSuppressedTypes(input: {
    appId: string;
    recipient: string;
    nowIso: string;
  }): Promise<Set<ObserverInsightType>>;
  getInsightCursor(
    appId: string,
    subject: ObserverSubjectKey,
  ): Promise<ObserverInsightCursor | null>;
  saveInsightCursor(
    appId: string,
    subject: ObserverSubjectKey,
    cursor: ObserverInsightCursor,
    expectedCursor: ObserverInsightCursor | null,
    nowIso: string,
  ): Promise<boolean>;
}

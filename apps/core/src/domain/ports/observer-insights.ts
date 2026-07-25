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

export interface ObserverInsightCursor {
  updatedAt: string;
  pageId: string;
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

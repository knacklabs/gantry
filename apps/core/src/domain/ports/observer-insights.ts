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

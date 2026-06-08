import { hashText } from './app-memory-canonical-codec.js';
import { subjectIdFor } from './app-memory-boundaries.js';
import {
  clampConfidence,
  encodeItemSource,
  normalizeKind,
  parseItemSource,
} from './app-memory-canonical-codec.js';
import { conversationIdForChannel } from './app-memory-service-record-mappers.js';
import type {
  NormalizedMemorySubject,
  SaveAppMemoryInput,
} from './memory-types.js';

export function memoryContentHash(input: {
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  key: string;
  value: string;
}): string {
  return hashText(
    `${input.appId}:${input.agentId}:${input.subjectType}:${input.subjectId}:${input.key}:${input.value}`,
  );
}

/**
 * Canonical text that is embedded for a memory item. The content hash is taken
 * over exactly this string so that any change to key/value/why re-embeds the
 * item (and only that item). Dreaming and backfill share this so a single ready
 * vector represents the item's current text.
 */
export function embeddingTextForMemory(input: {
  key: string;
  value: string;
  why?: string | null;
}): string {
  return `${input.key}\n${input.value}\n${input.why ?? ''}`;
}

export function embeddingContentHash(input: {
  key: string;
  value: string;
  why?: string | null;
}): string {
  return hashText(embeddingTextForMemory(input));
}

export function isUniqueViolation(err: unknown): boolean {
  if (err !== null && typeof err === 'object') {
    if ('code' in err && (err as { code?: unknown }).code === '23505') {
      return true;
    }
    if ('cause' in err) {
      return isUniqueViolation((err as { cause?: unknown }).cause);
    }
  }
  return false;
}

type ParsedItemSource = ReturnType<typeof parseItemSource>;

export function buildMemoryItemWriteBase(input: {
  subject: NormalizedMemorySubject;
  saveInput: SaveAppMemoryInput;
  key: string;
  value: string;
  evidenceIds: string[];
  existingSource: ParsedItemSource | null;
  timestamp: string;
}) {
  const nextEvidenceIds = Array.from(
    new Set([
      ...(input.existingSource?.evidenceIds ?? []),
      ...input.evidenceIds,
    ]),
  );
  const nextVersion = input.existingSource
    ? input.existingSource.version + 1
    : 1;
  const sourceRef = encodeItemSource({
    subject: input.subject,
    source: input.saveInput.source || 'sdk',
    evidenceIds: nextEvidenceIds,
    isPinned: input.existingSource?.isPinned ?? false,
    version: nextVersion,
    retrievalCount: input.existingSource?.retrievalCount,
    totalScore: input.existingSource?.totalScore,
    maxScore: input.existingSource?.maxScore,
  });
  if (input.saveInput.dreamingPromotion) {
    sourceRef.promoted_by = 'dreaming';
    sourceRef.promoted_at = input.saveInput.dreamingPromotion.promotedAt;
    sourceRef.dream_run_id = input.saveInput.dreamingPromotion.runId;
    if (input.saveInput.dreamingPromotion.candidateId) {
      sourceRef.dream_candidate_id =
        input.saveInput.dreamingPromotion.candidateId;
    }
  }
  return {
    appId: input.subject.appId,
    agentId: input.subject.agentId,
    subjectType: input.subject.subjectType,
    subjectId: subjectIdFor(input.subject),
    userId: input.subject.userId ?? null,
    conversationId: conversationIdForChannel(input.subject.channelId),
    threadId: null,
    kind: normalizeKind(input.saveInput.kind),
    key: input.key,
    valueJson: {
      value: input.value,
      why: input.saveInput.why?.trim() || null,
      contentHash: memoryContentHash({
        appId: input.subject.appId,
        agentId: input.subject.agentId,
        subjectType: input.subject.subjectType,
        subjectId: input.subject.subjectId,
        key: input.key,
        value: input.value,
      }),
    },
    sourceRefJson: sourceRef,
    confidence: clampConfidence(input.saveInput.confidence),
    status: 'active' as const,
    lastObservedAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

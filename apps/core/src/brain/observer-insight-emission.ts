import { createHash, randomUUID } from 'node:crypto';

import type { PatternCandidate } from '@gantry/contracts';

import type {
  ObserverInsightCursor,
  ObserverInsightRepository,
  ObserverInsightType,
  ObserverSubjectKey,
} from '../domain/ports/observer-insights.js';
import { OBSERVER_INSIGHT_TYPES } from '../domain/ports/observer-insights.js';
import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import {
  loadCanonicalActiveMemoryValues,
  type ObserverActiveMemoryReadPort,
} from '../memory/observer-active-memory.js';
import { isUniqueViolation } from '../memory/app-memory-service-helpers.js';
import { embeddingCacheTextHash } from '../memory/memory-embedding-cache.js';
import type { EmbeddingProvider } from '../memory/memory-embeddings.js';
import { canonicalConversationIdForPattern } from '../shared/pattern-candidate-subject.js';
import {
  canonicalizeObserverInsightText,
  cosineSimilarity,
  evaluateObserverInsightFloor,
  OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD,
} from '../shared/observer-insight-policy.js';
import { nowIso } from '../shared/time/datetime.js';
import type { BrainPage } from './brain-types.js';

export const OBSERVER_APP_SUBJECT: ObserverSubjectKey = 'observer:app';
export const OBSERVER_CURSOR_SUBJECT: ObserverSubjectKey = 'observer:app';
export const OBSERVER_EMBEDDINGS_UNAVAILABLE_MESSAGE =
  'Insight emission paused: embeddings unavailable.';

const LLM_INSIGHT_TYPES = new Set<ObserverInsightType>(
  OBSERVER_INSIGHT_TYPES.filter((type) => type !== 'repetition'),
);

export interface SurfaceableInsightDraft {
  insightType: Exclude<ObserverInsightType, 'repetition'>;
  title: string;
  summary: string;
  canonicalSignature: string;
  confidence: number;
  evidencePageIds: string[];
}

export type ObserverInsightEmissionRuntime =
  | { enabled: false }
  | {
      enabled: true;
      ownerRecipient: string;
      cursorSubject: ObserverSubjectKey;
      repository: ObserverInsightRepository;
      patterns: PatternCandidateRepository;
      activeMemory: ObserverActiveMemoryReadPort;
      embedding?: EmbeddingProvider;
      embeddingModel: string;
      embeddingDimensions: number;
    };

interface PageDraft {
  draft: SurfaceableInsightDraft;
  page: BrainPage;
}

interface NormalizedCandidate {
  subject: ObserverSubjectKey;
  insightType: ObserverInsightType;
  title: string;
  summary: string;
  content: string;
  signatureIdentity: string;
  confidence: number;
  evidenceRefs: Array<{
    conversationId: string;
    messageId: string;
    ts: string;
  }>;
  batchSnapshotAt: string;
}

interface EmbeddedCandidate extends NormalizedCandidate {
  embedding: number[];
}

export function normalizeSurfaceableInsightDraft(
  value: unknown,
  evidencePageId: string,
): SurfaceableInsightDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const insightType = row.insightType;
  const title = stringValue(row.title);
  const summary = stringValue(row.summary);
  const canonicalSignature = stringValue(row.canonicalSignature);
  const confidence = row.confidence;
  const evidencePageIds =
    Array.isArray(row.evidencePageIds) &&
    row.evidencePageIds.some((id) => id === evidencePageId)
      ? [evidencePageId]
      : [];
  if (
    !LLM_INSIGHT_TYPES.has(insightType as ObserverInsightType) ||
    !title ||
    !summary ||
    !canonicalSignature ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null;
  }
  return {
    insightType: insightType as SurfaceableInsightDraft['insightType'],
    title,
    summary,
    canonicalSignature,
    confidence,
    evidencePageIds,
  };
}

export function observerSubjectForPage(page: BrainPage): ObserverSubjectKey {
  if (page.sourceKind !== 'channel' || !page.sourceRef) {
    return OBSERVER_APP_SUBJECT;
  }
  const withoutFragment = page.sourceRef.split('#', 1)[0]?.trim() ?? '';
  const separator = withoutFragment.indexOf(':');
  const conversationId =
    separator >= 0 ? withoutFragment.slice(separator + 1).trim() : '';
  return conversationId
    ? (`conversation:${conversationId}` as ObserverSubjectKey)
    : OBSERVER_APP_SUBJECT;
}

export async function emitObserverInsights(input: {
  enabled: true;
  appId: string;
  ownerRecipient: string;
  cursorSubject: ObserverSubjectKey;
  repository: ObserverInsightRepository;
  patterns: PatternCandidateRepository;
  activeMemory: ObserverActiveMemoryReadPort;
  embedding?: EmbeddingProvider;
  embeddingModel: string;
  embeddingDimensions: number;
  drafts: PageDraft[];
  cursor: ObserverInsightCursor | null;
  cursorTarget?: BrainPage;
  signal?: AbortSignal;
}): Promise<{
  persisted: number;
  deduplicated: number;
  filtered: number;
  message: string;
}> {
  const embedding = input.embedding;
  try {
    if (!embedding?.isEnabled()) return pausedResult();
    embedding.validateConfiguration();
    await embedding.validateReady?.({ signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return pausedResult();
  }

  const patterns = input.patterns.listEligibleForApp
    ? await input.patterns.listEligibleForApp({
        appId: input.appId,
        limit: 20,
      })
    : [];
  const candidates = [
    ...input.drafts.map(normalizePageCandidate),
    ...patterns.map(normalizePatternCandidate),
  ].filter((candidate): candidate is NormalizedCandidate => candidate !== null);

  if (candidates.length === 0) {
    const createdAt = nowIso();
    if (input.cursorTarget) {
      await input.repository.saveInsightCursor(
        input.appId,
        input.cursorSubject,
        {
          updatedAt: input.cursorTarget.updatedAt,
          pageId: input.cursorTarget.id,
        },
        input.cursor,
        createdAt,
      );
    }
    return {
      persisted: 0,
      deduplicated: 0,
      filtered: 0,
      message:
        'Insight emission complete: 0 persisted, 0 deduplicated, 0 filtered.',
    };
  }

  let embeddings: number[][];
  try {
    embeddings = await embedding.embedMany(
      candidates.map((candidate) => candidate.content),
      { signal: input.signal },
    );
    if (
      embeddings.length !== candidates.length ||
      embeddings.some(
        (vector) =>
          vector.length !== input.embeddingDimensions ||
          vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      return pausedResult();
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return pausedResult();
  }

  const embedded = candidates.map((candidate, index) => ({
    ...candidate,
    embedding: embeddings[index]!,
  }));
  const activeMemoryBySubject = new Map(
    await Promise.all(
      [...new Set(embedded.map((candidate) => candidate.subject))].map(
        async (subject) =>
          [
            subject,
            await loadCanonicalActiveMemoryValues({
              memory: input.activeMemory,
              appId: input.appId,
              subject,
            }),
          ] as const,
      ),
    ),
  );
  const accepted: EmbeddedCandidate[] = [];
  let deduplicated = 0;
  let filtered = 0;

  for (const candidate of embedded) {
    input.signal?.throwIfAborted();
    const canonicalSignature = signatureFor(
      candidate.subject,
      candidate.signatureIdentity,
    );
    if (
      candidate.insightType === 'repetition' &&
      (await input.repository.findHistoricalBySignature({
        appId: input.appId,
        subject: candidate.subject,
        canonicalSignature,
      }))
    ) {
      continue;
    }
    const [exactInsight, semanticInsight] = await Promise.all([
      input.repository.findBySignature({
        appId: input.appId,
        subject: candidate.subject,
        canonicalSignature,
      }),
      input.repository.findSemanticDuplicate({
        appId: input.appId,
        subject: candidate.subject,
        model: input.embeddingModel,
        dimensions: input.embeddingDimensions,
        embedding: candidate.embedding,
        minSimilarity: OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD,
      }),
    ]);
    const activeMemoryDuplicate =
      activeMemoryBySubject.get(candidate.subject)?.has(candidate.content) ??
      false;
    const sameRunDuplicate = accepted.some(
      (other) =>
        other.subject === candidate.subject &&
        cosineSimilarity(other.embedding, candidate.embedding) >=
          OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD,
    );
    const decision = evaluateObserverInsightFloor({
      confidence: candidate.confidence,
      evidenceCount: candidate.evidenceRefs.length,
      exactInsightDuplicate: exactInsight !== null,
      semanticInsightDuplicate: semanticInsight !== null || sameRunDuplicate,
      activeMemoryDuplicate,
    });
    if (!decision.accepted) {
      if (
        decision.reason === 'exact_insight_duplicate' ||
        decision.reason === 'semantic_insight_duplicate'
      ) {
        deduplicated += 1;
      } else {
        filtered += 1;
      }
      continue;
    }
    accepted.push(candidate);
  }

  let persisted = 0;
  const createdAt = nowIso();
  for (const candidate of accepted) {
    const canonicalSignature = signatureFor(
      candidate.subject,
      candidate.signatureIdentity,
    );
    try {
      await input.repository.create({
        id: insightId(),
        appId: input.appId,
        subject: candidate.subject,
        insightType: candidate.insightType,
        title: candidate.title,
        summary: candidate.summary,
        evidenceRefs: candidate.evidenceRefs,
        batchSnapshotAt: candidate.batchSnapshotAt,
        evidenceVersion: 1,
        canonicalSignature,
        signatureEmbeddingRef: embeddingCacheTextHash(candidate.content),
        confidence: candidate.confidence,
        priorityScore: candidate.confidence,
        recipient: input.ownerRecipient,
        nowIso: createdAt,
      });
      persisted += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      deduplicated += 1;
    }
  }

  if (input.cursorTarget) {
    await input.repository.saveInsightCursor(
      input.appId,
      input.cursorSubject,
      {
        updatedAt: input.cursorTarget.updatedAt,
        pageId: input.cursorTarget.id,
      },
      input.cursor,
      createdAt,
    );
  }
  return {
    persisted,
    deduplicated,
    filtered,
    message: `Insight emission complete: ${persisted} persisted, ${deduplicated} deduplicated, ${filtered} filtered.`,
  };
}

function normalizePageCandidate(input: PageDraft): NormalizedCandidate | null {
  const content = canonicalizeObserverInsightText(
    input.draft.canonicalSignature,
  );
  if (!content) return null;
  const subject = observerSubjectForPage(input.page);
  return {
    subject,
    insightType: input.draft.insightType,
    title: input.draft.title,
    summary: input.draft.summary,
    content,
    signatureIdentity: content,
    confidence: input.draft.confidence,
    evidenceRefs: input.draft.evidencePageIds.map((messageId) => ({
      conversationId: subject,
      messageId,
      ts: input.page.updatedAt,
    })),
    batchSnapshotAt: input.page.updatedAt,
  };
}

function normalizePatternCandidate(
  candidate: PatternCandidate,
): NormalizedCandidate | null {
  if (candidate.subjectType !== 'channel') return null;
  const conversationId = canonicalConversationIdForPattern(candidate.subjectId);
  const content = canonicalizeObserverInsightText(
    `repetition ${candidate.outcomeLabel}`,
  );
  if (!conversationId || !content) return null;
  const subject = conversationId as ObserverSubjectKey;
  const lastDetectedAt = isoTimestamp(candidate.lastDetectedAt);
  return {
    subject,
    insightType: 'repetition',
    title: `Repeated work: ${candidate.outcomeLabel}`,
    summary: candidate.shortAsk,
    content,
    signatureIdentity: `${content}\0repetition:v1:${candidate.occurrences}:${lastDetectedAt}`,
    confidence: 1,
    evidenceRefs: candidate.evidenceRefs
      .filter((reference) => reference.kind === 'transcript')
      .map((reference) => ({
        conversationId: subject,
        messageId: reference.id,
        ts: lastDetectedAt,
      })),
    batchSnapshotAt: lastDetectedAt,
  };
}

function signatureFor(subject: ObserverSubjectKey, content: string): string {
  return hash(`${subject}\0${content}`);
}

function insightId(): string {
  return `obs_${randomUUID().replace(/-/g, '')}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isoTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pausedResult(): {
  persisted: number;
  deduplicated: number;
  filtered: number;
  message: string;
} {
  return {
    persisted: 0,
    deduplicated: 0,
    filtered: 0,
    message: OBSERVER_EMBEDDINGS_UNAVAILABLE_MESSAGE,
  };
}

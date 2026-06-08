import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type {
  AppMemoryItem,
  DreamDecisionAction,
  MemoryLifecycleProposal,
  DreamingRunStatus,
  MemoryKind,
  NormalizedMemorySubject,
  SaveAppMemoryInput,
} from './memory-types.js';
import { embeddingContentHash } from './app-memory-service-helpers.js';
import { hashText } from './app-memory-canonical-codec.js';
import {
  extractMemoryValue,
  parseStagedCandidateMetadata,
  parseStructuredEvidenceCandidate,
  validatePromotableCandidate,
} from './app-memory-dreaming-candidate-guardrails.js';
import {
  isUnsafeEvidence,
  parseJsonArray,
  parseJsonObject,
} from './app-memory-dreaming-evidence.js';
import { nowIso as currentIso } from '../shared/time/datetime.js';
type Db = NodePgDatabase<typeof pgSchema>;
type MemoryItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
// prettier-ignore
type CreatePendingReview = (p: MemoryLifecycleProposal, db?: Db) => Promise<string>;
// prettier-ignore
type DreamEmbeddingResult = { status: 'stored' | 'disabled' | 'retryable'; reason?: string };
function nowIso(): string {
  return currentIso();
}
async function setCandidateStatus(db: Db, id: string, status: string) {
  await db
    .update(pgSchema.memoryCandidatesPostgres)
    .set({ status, updatedAt: nowIso() })
    .where(eq(pgSchema.memoryCandidatesPostgres.id, id));
}
async function recordDreamDecision(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  action: DreamDecisionAction;
  rationale: string;
  itemId?: string;
  candidateId?: string;
  evidenceIds?: string[];
  applied: boolean;
}): Promise<void> {
  await input.db.insert(pgSchema.memoryDreamDecisionsPostgres).values({
    id: `mdd_${randomUUID().replace(/-/g, '')}`,
    runId: input.runId,
    appId: input.subject.appId,
    agentId: input.subject.agentId,
    threadId: null,
    itemId: input.itemId ?? null,
    candidateId: input.candidateId ?? null,
    action: input.action,
    rationale: input.rationale,
    evidenceIdsJson: JSON.stringify(input.evidenceIds || []),
    applied: input.applied,
    createdAt: nowIso(),
  });
}
async function candidateCitesUnsafeEvidence(db: Db, evidenceIds: string[]) {
  if (evidenceIds.length === 0) return false;
  const evidenceRows = await db
    .select()
    .from(pgSchema.memoryEvidencePostgres)
    .where(inArray(pgSchema.memoryEvidencePostgres.id, evidenceIds))
    .limit(Math.min(evidenceIds.length, 100));
  return evidenceRows.some(isUnsafeEvidence);
}
// prettier-ignore
function candidateMemoryKind(kind: string): MemoryKind | undefined { return ['preference', 'decision', 'fact', 'correction', 'constraint'].includes(kind) ? (kind as MemoryKind) : undefined; }
async function routeMemoryProposalToReview(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  dryRun: boolean;
  createPendingReview?: CreatePendingReview;
  proposal: MemoryLifecycleProposal;
  candidateId?: string;
  itemId?: string;
  evidenceIds?: string[];
  reviewRationale: string;
  blockRationale: string;
}): Promise<DreamDecisionAction> {
  if (input.dryRun) {
    await recordDreamDecision({
      db: input.db,
      runId: input.runId,
      subject: input.subject,
      action: 'dry_run',
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      rationale: input.reviewRationale,
      ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
      applied: false,
    });
    return 'dry_run';
  }
  let reviewId = '';
  const createReview = (db = input.db) =>
    input.createPendingReview?.(input.proposal, db) || '';
  try {
    if (input.candidateId) {
      reviewId = await input.db.transaction(async (tx) => {
        await setCandidateStatus(tx, input.candidateId!, 'needs_review');
        const id = await createReview(tx);
        if (!id) {
          throw new Error('pending memory review creation returned empty id');
        }
        return id;
      });
    } else {
      reviewId = await createReview();
    }
  } catch {
    reviewId = '';
  }
  const action = reviewId ? 'needs_review' : 'blocked';
  if (input.candidateId && !reviewId) {
    await setCandidateStatus(input.db, input.candidateId, action);
  }
  await recordDreamDecision({
    db: input.db,
    runId: input.runId,
    subject: input.subject,
    action,
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    rationale: reviewId
      ? `${input.reviewRationale}: ${reviewId}.`
      : input.blockRationale,
    ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
    applied: false,
  });
  return action;
}
async function blockCandidate(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  candidateId: string;
  rationale: string;
  evidenceIds: string[];
  dryRun: boolean;
  itemId?: string;
}): Promise<void> {
  if (!input.dryRun) {
    await setCandidateStatus(input.db, input.candidateId, 'blocked');
  }
  await recordDreamDecision({ ...input, action: 'blocked', applied: false });
}
export async function runAppMemoryDreamPass(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  phase: DreamingRunStatus['phase'];
  dryRun: boolean;
  signal?: AbortSignal;
  remainingTimeoutMs?: () => number | undefined;
  listItems: () => Promise<Array<{ row: MemoryItemRow }>>;
  save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
  retire: (
    input: {
      id: string;
      isAdminWrite?: boolean;
    } & Partial<NormalizedMemorySubject>,
  ) => Promise<{ deleted: boolean }>;
  storeDreamEmbedding?: (input: {
    item: AppMemoryItem;
    contentHash: string;
  }) => Promise<DreamEmbeddingResult>;
  proposeDreaming?: (input: {
    evidence: (typeof pgSchema.memoryEvidencePostgres.$inferSelect)[];
    candidates: (typeof pgSchema.memoryCandidatesPostgres.$inferSelect)[];
    activeItems: MemoryItemRow[];
  }) => Promise<MemoryLifecycleProposal[]>;
  proposeConsolidation?: (input: {
    activeItems: MemoryItemRow[];
  }) => Promise<MemoryLifecycleProposal[]>;
  createPendingReview?: CreatePendingReview;
}): Promise<Array<{ action: DreamDecisionAction }>> {
  const { db, runId, subject, phase, dryRun } = input;
  input.signal?.throwIfAborted();
  const decisions: Array<{ action: DreamDecisionAction }> = [];
  const recentEvidence = await db
    .select()
    .from(pgSchema.memoryEvidencePostgres)
    .where(
      and(
        eq(pgSchema.memoryEvidencePostgres.appId, subject.appId),
        eq(pgSchema.memoryEvidencePostgres.agentId, subject.agentId),
        eq(pgSchema.memoryEvidencePostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryEvidencePostgres.subjectId, subject.subjectId),
      ),
    )
    .orderBy(desc(pgSchema.memoryEvidencePostgres.createdAt))
    .limit(25);
  input.signal?.throwIfAborted();
  const unsafeEvidenceIds = new Set(
    recentEvidence.filter(isUnsafeEvidence).map((evidence) => evidence.id),
  );
  const safeRecentEvidence = recentEvidence.filter(
    (evidence) => !unsafeEvidenceIds.has(evidence.id),
  );
  if (phase === 'light' || phase === 'all') {
    for (const evidence of safeRecentEvidence.slice(0, 10)) {
      input.signal?.throwIfAborted();
      const parsed = parseStructuredEvidenceCandidate(evidence, subject);
      if (!parsed.candidate) {
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'skip',
          rationale: `Light dreaming skipped evidence: ${parsed.rejection}.`,
          evidenceIds: [evidence.id],
          applied: false,
        });
        decisions.push({ action: 'skip' });
        continue;
      }
      const candidate = parsed.candidate;
      const candidateId = `mca_${hashText(`${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}:${candidate.kind}:${candidate.key}:${candidate.value}`).slice(0, 32)}`;
      if (!dryRun) {
        await db
          .insert(pgSchema.memoryCandidatesPostgres)
          .values({
            id: candidateId,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            threadId: null,
            kind: candidate.kind,
            key: candidate.key,
            value: candidate.value,
            reason: candidate.why,
            metadataJson: JSON.stringify({
              operation: candidate.operation,
              ...(candidate.retireKey
                ? { retire_key: candidate.retireKey }
                : {}),
            }),
            evidenceIdsJson: JSON.stringify([evidence.id]),
            confidence: candidate.confidence,
            status: 'staged',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          .onConflictDoNothing();
      }
      await recordDreamDecision({
        db,
        runId,
        subject,
        action: 'stage_candidate',
        candidateId,
        rationale: dryRun
          ? 'Light dreaming would stage structured evidence that passed canonical kind, confidence, scope, and safety guardrails.'
          : 'Light dreaming staged structured evidence that passed canonical kind, confidence, scope, and safety guardrails.',
        evidenceIds: [evidence.id],
        applied: !dryRun,
      });
      decisions.push({ action: 'stage_candidate' });
    }
  }
  if (phase === 'rem' || phase === 'all') {
    input.signal?.throwIfAborted();
    const items = await input.listItems();
    for (const item of items) {
      input.signal?.throwIfAborted();
      const payload = parseJsonObject(item.row.valueJson);
      const value =
        typeof payload.value === 'string' ? payload.value.toLowerCase() : '';
      if (/\b(no longer|instead|actually|correction|wrong)\b/.test(value)) {
        const action = await routeMemoryProposalToReview({
          db,
          runId,
          subject,
          dryRun,
          createPendingReview: input.createPendingReview,
          itemId: item.row.id,
          evidenceIds: [],
          proposal: {
            action: 'needs_review',
            itemId: item.row.id,
            key: item.row.key,
            value: extractMemoryValue(item.row),
            reason:
              'REM dreaming found correction language; human or admin review should decide whether to rewrite or retire related memory.',
            confidence: item.row.confidence,
            evidenceIds: [],
          },
          reviewRationale:
            'REM dreaming routed correction language to memory review',
          blockRationale:
            'REM dreaming blocked correction-language review because memory review creation failed.',
        });
        decisions.push({ action });
      }
    }
  }
  if (phase === 'deep' || phase === 'all') {
    input.signal?.throwIfAborted();
    const activeItems = await input.listItems();
    const activeByKey = new Map<
      string,
      { id: string; key: string; kind: string; value: string }
    >();
    for (const item of activeItems) {
      if (!activeByKey.has(item.row.key)) {
        activeByKey.set(item.row.key, {
          id: item.row.id,
          key: item.row.key,
          kind: item.row.kind,
          value: extractMemoryValue(item.row),
        });
      }
    }
    const candidates = await db
      .select()
      .from(pgSchema.memoryCandidatesPostgres)
      .where(
        and(
          eq(pgSchema.memoryCandidatesPostgres.appId, subject.appId),
          eq(pgSchema.memoryCandidatesPostgres.agentId, subject.agentId),
          eq(
            pgSchema.memoryCandidatesPostgres.subjectType,
            subject.subjectType,
          ),
          eq(pgSchema.memoryCandidatesPostgres.subjectId, subject.subjectId),
          eq(pgSchema.memoryCandidatesPostgres.status, 'staged'),
        ),
      )
      .orderBy(desc(pgSchema.memoryCandidatesPostgres.confidence))
      .limit(10);
    input.signal?.throwIfAborted();
    const llmDreamingProposals =
      (await input.proposeDreaming?.({
        evidence: safeRecentEvidence,
        candidates,
        activeItems: activeItems.map((item) => item.row),
      })) || [];
    input.signal?.throwIfAborted();
    const llmConsolidationProposals =
      (await input.proposeConsolidation?.({
        activeItems: activeItems.map((item) => item.row),
      })) || [];
    input.signal?.throwIfAborted();
    for (const proposal of [
      ...llmDreamingProposals,
      ...llmConsolidationProposals,
    ]) {
      input.signal?.throwIfAborted();
      if (
        proposal.action === 'retire' ||
        proposal.action === 'rewrite' ||
        proposal.action === 'merge' ||
        proposal.action === 'needs_review'
      ) {
        const action = await routeMemoryProposalToReview({
          db,
          runId,
          subject,
          dryRun,
          createPendingReview: input.createPendingReview,
          proposal,
          itemId: proposal.itemId || proposal.itemIds?.[0],
          candidateId: proposal.candidateId,
          evidenceIds: proposal.evidenceIds,
          reviewRationale: 'LLM proposal requires memory review',
          blockRationale:
            'LLM proposal blocked because memory review creation failed.',
        });
        decisions.push({ action });
      }
    }
    for (const candidate of candidates) {
      input.signal?.throwIfAborted();
      const evidenceIds = parseJsonArray(candidate.evidenceIdsJson);
      if (
        evidenceIds.some((id) => unsafeEvidenceIds.has(id)) ||
        (await candidateCitesUnsafeEvidence(db, evidenceIds))
      ) {
        await blockCandidate({
          db,
          runId,
          subject,
          candidateId: candidate.id,
          rationale:
            'Deep dreaming blocked candidate because it cites quarantined or unsafe Memory Source evidence.',
          evidenceIds,
          dryRun,
        });
        decisions.push({ action: 'blocked' });
        continue;
      }
      const metadata = parseStagedCandidateMetadata(candidate);
      const existing = activeByKey.get(candidate.key);
      const reviewKind = candidateMemoryKind(candidate.kind);
      if (metadata.operation === 'retire') {
        const retireTarget = activeByKey.get(
          metadata.retireKey || candidate.key,
        );
        if (!retireTarget) {
          if (!dryRun) {
            await setCandidateStatus(db, candidate.id, 'skipped');
          }
          await recordDreamDecision({
            db,
            runId,
            subject,
            action: 'skip',
            candidateId: candidate.id,
            rationale:
              'Deep dreaming skipped retire candidate because no active target memory was found.',
            evidenceIds,
            applied: false,
          });
          decisions.push({ action: 'skip' });
          continue;
        }
        if (dryRun) {
          await recordDreamDecision({
            db,
            runId,
            subject,
            action: 'dry_run',
            itemId: retireTarget.id,
            candidateId: candidate.id,
            rationale:
              'Deep dreaming dry run would retire the targeted active memory item.',
            evidenceIds,
            applied: false,
          });
          decisions.push({ action: 'dry_run' });
          continue;
        }
        const action = await routeMemoryProposalToReview({
          db,
          runId,
          subject,
          dryRun,
          createPendingReview: input.createPendingReview,
          candidateId: candidate.id,
          itemId: retireTarget.id,
          evidenceIds,
          proposal: {
            action: 'retire',
            candidateId: candidate.id,
            itemId: retireTarget.id,
            ...(reviewKind ? { kind: reviewKind } : {}),
            key: retireTarget.key,
            reason:
              candidate.reason ||
              'Deep dreaming proposed retiring this active memory item.',
            confidence: candidate.confidence,
            evidenceIds,
          },
          reviewRationale:
            'Deep dreaming routed retire candidate to memory review',
          blockRationale:
            'Deep dreaming blocked retire candidate because memory review creation failed.',
        });
        decisions.push({ action });
        continue;
      }
      const validation = validatePromotableCandidate(candidate);
      if (!validation.ok) {
        if (!validation.needsReview) {
          await blockCandidate({
            db,
            runId,
            subject,
            candidateId: candidate.id,
            rationale: validation.rationale,
            evidenceIds,
            dryRun,
          });
          decisions.push({ action: 'blocked' });
          continue;
        }
        const action = await routeMemoryProposalToReview({
          db,
          runId,
          subject,
          dryRun,
          createPendingReview: input.createPendingReview,
          candidateId: candidate.id,
          evidenceIds,
          proposal: {
            action: 'promote',
            candidateId: candidate.id,
            ...(reviewKind ? { kind: reviewKind } : {}),
            key: candidate.key,
            value: candidate.value,
            reason: candidate.reason || validation.rationale,
            confidence: candidate.confidence,
            evidenceIds,
          },
          reviewRationale: `${validation.rationale} Routed to memory review`,
          blockRationale: validation.rationale,
        });
        decisions.push({ action });
        continue;
      }
      if (existing && existing.value !== candidate.value) {
        const action = await routeMemoryProposalToReview({
          db,
          runId,
          subject,
          dryRun,
          createPendingReview: input.createPendingReview,
          candidateId: candidate.id,
          itemId: existing.id,
          evidenceIds,
          proposal: {
            action: 'needs_review',
            candidateId: candidate.id,
            itemId: existing.id,
            ...(reviewKind ? { kind: reviewKind } : {}),
            key: existing.key,
            value: candidate.value,
            reason:
              candidate.reason ||
              'Deep dreaming proposed changing active memory with the same key.',
            confidence: candidate.confidence,
            evidenceIds,
          },
          reviewRationale:
            'Deep dreaming routed candidate to memory review because it changes an active memory with the same key',
          blockRationale:
            'Deep dreaming blocked candidate because memory review creation failed.',
        });
        decisions.push({ action });
        continue;
      }
      if (
        existing &&
        existing.kind === candidate.kind &&
        existing.value === candidate.value
      ) {
        if (!dryRun) {
          await setCandidateStatus(db, candidate.id, 'skipped');
        }
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'skip',
          itemId: existing.id,
          candidateId: candidate.id,
          rationale:
            'Deep dreaming skipped candidate because active memory already matches the staged value.',
          evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'skip' });
        continue;
      }
      if (dryRun) {
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'dry_run',
          ...(existing ? { itemId: existing.id } : {}),
          candidateId: candidate.id,
          rationale: existing
            ? 'Deep dreaming dry run would update an active memory from this staged candidate.'
            : 'Deep dreaming dry run would promote this staged candidate into active memory.',
          evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'dry_run' });
        continue;
      }
      const promotedAt = nowIso();
      const saved = await input.save({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        userId: subject.userId,
        groupId: subject.groupId,
        channelId: subject.channelId,
        kind: candidate.kind as MemoryKind,
        key: candidate.key,
        value: candidate.value,
        why: candidate.reason || undefined,
        confidence: Math.max(0.6, candidate.confidence),
        source: 'dreaming',
        evidenceIds,
        dreamingPromotion: {
          runId,
          promotedAt,
          candidateId: candidate.id,
        },
        isAdminWrite: subject.subjectType === 'common',
      });
      await setCandidateStatus(
        db,
        candidate.id,
        existing ? 'updated' : 'promoted',
      );
      const action: DreamDecisionAction = existing ? 'update' : 'promote';
      await recordDreamDecision({
        db,
        runId,
        subject,
        action,
        itemId: saved.id,
        candidateId: candidate.id,
        rationale: existing
          ? 'Deep dreaming updated an active memory item from a validated staged candidate.'
          : validation.rationale,
        evidenceIds,
        applied: true,
      });
      decisions.push({ action });
      activeByKey.set(candidate.key, {
        id: saved.id,
        key: saved.key,
        kind: saved.kind,
        value: saved.value,
      });
      const contentHash = embeddingContentHash({
        key: saved.key,
        value: saved.value,
        why: saved.why ?? null,
      });
      const embeddingResult = await input.storeDreamEmbedding?.({
        item: saved,
        contentHash,
      });
      if (embeddingResult?.status === 'retryable') {
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'blocked',
          itemId: saved.id,
          candidateId: candidate.id,
          rationale:
            embeddingResult.reason ||
            'Dream embedding persistence failed with retryable status.',
          evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'blocked' });
      }
    }
  }
  return decisions;
}

import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';
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
import { memoryContentHash } from './app-memory-service-helpers.js';
import { hashText } from './app-memory-canonical-codec.js';
import {
  extractMemoryValue,
  parseStagedCandidateMetadata,
  parseStructuredEvidenceCandidate,
  validatePromotableCandidate,
} from './app-memory-dreaming-candidate-guardrails.js';

type Db = NodePgDatabase<typeof pgSchema>;
type MemoryItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;

interface DreamEmbeddingResult {
  status: 'stored' | 'disabled' | 'retryable';
  reason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sqlThreadScopeFilter(column: any, threadId: string | undefined) {
  return threadId ? eq(column, threadId) : isNull(column);
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
    threadId: input.subject.threadId ?? null,
    itemId: input.itemId ?? null,
    candidateId: input.candidateId ?? null,
    action: input.action,
    rationale: input.rationale,
    evidenceIdsJson: JSON.stringify(input.evidenceIds || []),
    applied: input.applied,
    createdAt: nowIso(),
  });
}

export async function runAppMemoryDreamPass(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  phase: DreamingRunStatus['phase'];
  dryRun: boolean;
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
  createPendingReview?: (proposal: MemoryLifecycleProposal) => Promise<string>;
}): Promise<Array<{ action: DreamDecisionAction }>> {
  const { db, runId, subject, phase, dryRun } = input;
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
        sqlThreadScopeFilter(
          pgSchema.memoryEvidencePostgres.threadId,
          subject.threadId,
        ),
      ),
    )
    .orderBy(desc(pgSchema.memoryEvidencePostgres.createdAt))
    .limit(25);

  if (phase === 'light' || phase === 'all') {
    for (const evidence of recentEvidence.slice(0, 10)) {
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
      const candidateId = `mca_${hashText(`${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}:${subject.threadId ?? ''}:${candidate.kind}:${candidate.key}:${candidate.value}`).slice(0, 32)}`;
      if (!dryRun) {
        await db
          .insert(pgSchema.memoryCandidatesPostgres)
          .values({
            id: candidateId,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            threadId: subject.threadId ?? null,
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
    const items = await input.listItems();
    for (const item of items) {
      const payload = parseJsonObject(item.row.valueJson);
      const value =
        typeof payload.value === 'string' ? payload.value.toLowerCase() : '';
      if (/\b(no longer|instead|actually|correction|wrong)\b/.test(value)) {
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'needs_review',
          itemId: item.row.id,
          rationale:
            'REM dreaming found correction language; human or admin review should decide whether to rewrite or retire related memory.',
          applied: false,
        });
        decisions.push({ action: 'needs_review' });
      }
    }
  }

  if (phase === 'deep' || phase === 'all') {
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
          sqlThreadScopeFilter(
            pgSchema.memoryCandidatesPostgres.threadId,
            subject.threadId,
          ),
          eq(pgSchema.memoryCandidatesPostgres.status, 'staged'),
        ),
      )
      .orderBy(desc(pgSchema.memoryCandidatesPostgres.confidence))
      .limit(10);
    const llmDreamingProposals =
      (await input.proposeDreaming?.({
        evidence: recentEvidence,
        candidates,
        activeItems: activeItems.map((item) => item.row),
      })) || [];
    const llmConsolidationProposals =
      (await input.proposeConsolidation?.({
        activeItems: activeItems.map((item) => item.row),
      })) || [];
    for (const proposal of [
      ...llmDreamingProposals,
      ...llmConsolidationProposals,
    ]) {
      if (
        proposal.action === 'retire' ||
        proposal.action === 'rewrite' ||
        proposal.action === 'merge' ||
        proposal.action === 'needs_review'
      ) {
        const reviewId = await input.createPendingReview?.(proposal);
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'needs_review',
          itemId: proposal.itemId || proposal.itemIds?.[0],
          candidateId: proposal.candidateId,
          rationale: reviewId
            ? `LLM proposal requires memory review: ${reviewId}.`
            : 'LLM proposal requires memory review.',
          evidenceIds: proposal.evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'needs_review' });
      }
    }
    for (const candidate of candidates) {
      const evidenceIds = parseJsonArray(candidate.evidenceIdsJson);
      const metadata = parseStagedCandidateMetadata(candidate);
      const existing = activeByKey.get(candidate.key);

      if (metadata.operation === 'retire') {
        const retireTarget = activeByKey.get(
          metadata.retireKey || candidate.key,
        );
        if (!retireTarget) {
          if (!dryRun) {
            await db
              .update(pgSchema.memoryCandidatesPostgres)
              .set({ status: 'skipped', updatedAt: nowIso() })
              .where(eq(pgSchema.memoryCandidatesPostgres.id, candidate.id));
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
        const reviewKind = [
          'preference',
          'decision',
          'fact',
          'correction',
          'constraint',
        ].includes(candidate.kind)
          ? (candidate.kind as MemoryKind)
          : undefined;
        const reviewId = await input.createPendingReview?.({
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
        });
        if (!reviewId) {
          await recordDreamDecision({
            db,
            runId,
            subject,
            action: 'blocked',
            itemId: retireTarget.id,
            candidateId: candidate.id,
            rationale:
              'Deep dreaming blocked retire candidate because memory review creation failed.',
            evidenceIds,
            applied: false,
          });
          decisions.push({ action: 'blocked' });
          continue;
        }
        await db
          .update(pgSchema.memoryCandidatesPostgres)
          .set({ status: 'needs_review', updatedAt: nowIso() })
          .where(eq(pgSchema.memoryCandidatesPostgres.id, candidate.id));
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'needs_review',
          itemId: retireTarget.id,
          candidateId: candidate.id,
          rationale: `Deep dreaming routed retire candidate to memory review: ${reviewId}.`,
          evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'needs_review' });
        continue;
      }

      const validation = validatePromotableCandidate(candidate);
      if (!validation.ok) {
        if (!dryRun) {
          await db
            .update(pgSchema.memoryCandidatesPostgres)
            .set({ status: 'needs_review', updatedAt: nowIso() })
            .where(eq(pgSchema.memoryCandidatesPostgres.id, candidate.id));
        }
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'blocked',
          candidateId: candidate.id,
          rationale: validation.rationale,
          evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'blocked' });
        continue;
      }
      if (
        existing &&
        existing.kind === candidate.kind &&
        existing.value === candidate.value
      ) {
        if (!dryRun) {
          await db
            .update(pgSchema.memoryCandidatesPostgres)
            .set({ status: 'skipped', updatedAt: nowIso() })
            .where(eq(pgSchema.memoryCandidatesPostgres.id, candidate.id));
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
      const saved = await input.save({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        userId: subject.userId,
        groupId: subject.groupId,
        channelId: subject.channelId,
        threadId: subject.threadId,
        kind: candidate.kind as MemoryKind,
        key: candidate.key,
        value: candidate.value,
        why: candidate.reason || undefined,
        confidence: Math.max(0.6, candidate.confidence),
        source: 'dreaming',
        evidenceIds,
        isAdminWrite: subject.subjectType === 'common',
      });
      await db
        .update(pgSchema.memoryCandidatesPostgres)
        .set({ status: existing ? 'updated' : 'promoted', updatedAt: nowIso() })
        .where(eq(pgSchema.memoryCandidatesPostgres.id, candidate.id));
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

      const contentHash = memoryContentHash({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        key: saved.key,
        value: saved.value,
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

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { classifySensitiveMemoryMaterial } from '../shared/sensitive-material.js';
import {
  itemMatchesSubjectBoundary,
  parseItemSource,
  parseJsonObject,
} from './app-memory-canonical-codec.js';
import {
  createSqlThreadIdentityFilter,
  nowIso,
  withStatementTimeout,
} from './app-memory-service-query-helpers.js';
import type {
  AppMemoryItem,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  MemoryLifecycleProposal,
  MemoryReviewDecisionInput,
  MemoryReviewRecord,
  MemorySubjectType,
  NormalizedMemorySubject,
  PatchAppMemoryInput,
  SaveAppMemoryInput,
} from './memory-types.js';
type Db = NodePgDatabase<typeof pgSchema>;
type MemoryReviewRow =
  typeof pgSchema.memoryReviewRequestsPostgres.$inferSelect;
const sqlThreadIdentityFilter = createSqlThreadIdentityFilter({ eq, isNull });
const REVIEW_APPLYABLE_ACTIONS = new Set([
  'promote',
  'retire',
  'rewrite',
  'merge',
  'needs_review',
]);
const GROUNDING_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'because',
  'before',
  'from',
  'have',
  'into',
  'must',
  'need',
  'needs',
  'only',
  'that',
  'their',
  'them',
  'this',
  'with',
]);
function parseJsonStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
function parseJsonNumberRecord(value: string): Record<string, number> {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}
function significantGroundingTokens(value: string): string[] {
  const tokens = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (!tokens) return [];
  return [...new Set(tokens)].filter(
    (token) => !GROUNDING_STOP_WORDS.has(token),
  );
}
function isValueGroundedInEvidence(
  value: string,
  evidenceRows: Array<typeof pgSchema.memoryEvidencePostgres.$inferSelect>,
): boolean {
  const valueTokens = significantGroundingTokens(value);
  if (!valueTokens.length) return false;
  const corpusTokens = new Set(
    evidenceRows.flatMap((evidence) =>
      significantGroundingTokens(evidence.text),
    ),
  );
  const hits = valueTokens.filter((token) => corpusTokens.has(token)).length;
  const required =
    valueTokens.length <= 3
      ? valueTokens.length
      : Math.ceil(valueTokens.length * 0.5);
  return hits >= required;
}
function parseReviewProposal(value: string): MemoryLifecycleProposal {
  const parsed = parseJsonObject(value);
  const action = typeof parsed.action === 'string' ? parsed.action : '';
  return {
    action: action as MemoryLifecycleProposal['action'],
    ...(typeof parsed.candidateId === 'string'
      ? { candidateId: parsed.candidateId }
      : {}),
    ...(typeof parsed.itemId === 'string' ? { itemId: parsed.itemId } : {}),
    ...(Array.isArray(parsed.itemIds)
      ? {
          itemIds: parsed.itemIds.filter(
            (entry): entry is string => typeof entry === 'string',
          ),
        }
      : {}),
    ...(typeof parsed.targetItemId === 'string'
      ? { targetItemId: parsed.targetItemId }
      : {}),
    ...(typeof parsed.kind === 'string'
      ? { kind: parsed.kind as MemoryLifecycleProposal['kind'] }
      : {}),
    ...(typeof parsed.key === 'string' ? { key: parsed.key } : {}),
    ...(typeof parsed.value === 'string' ? { value: parsed.value } : {}),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    confidence:
      typeof parsed.confidence === 'number' &&
      Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0,
    evidenceIds: Array.isArray(parsed.evidenceIds)
      ? parsed.evidenceIds.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  };
}
function toMemoryReview(row: MemoryReviewRow): MemoryReviewRecord {
  return {
    id: row.id,
    runId: row.runId,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    phase: row.phase as DreamingRunStatus['phase'],
    proposal: parseReviewProposal(row.proposalJson),
    status: row.status as MemoryReviewRecord['status'],
    itemVersions: parseJsonNumberRecord(row.itemVersionsJson),
    candidateVersions: parseJsonStringRecord(row.candidateVersionsJson),
    validationSummary: row.validationSummary,
    reviewerId: row.reviewerId,
    decision: row.decision as MemoryReviewRecord['decision'],
    editedValue: row.editedValue,
    editedReason: row.editedReason,
    applyOutcome: row.applyOutcome,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
  };
}
export async function listPendingMemoryReviews(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  statementTimeoutMs?: number;
}): Promise<MemoryReviewRecord[]> {
  const rows = (await withStatementTimeout(
    input.db,
    input.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (db) =>
      db
        .select()
        .from(pgSchema.memoryReviewRequestsPostgres)
        .where(
          and(
            eq(
              pgSchema.memoryReviewRequestsPostgres.appId,
              input.subject.appId,
            ),
            eq(
              pgSchema.memoryReviewRequestsPostgres.agentId,
              input.subject.agentId,
            ),
            eq(
              pgSchema.memoryReviewRequestsPostgres.subjectType,
              input.subject.subjectType,
            ),
            eq(
              pgSchema.memoryReviewRequestsPostgres.subjectId,
              input.subject.subjectId,
            ),
            sqlThreadIdentityFilter(
              pgSchema.memoryReviewRequestsPostgres,
              input.subject.threadId,
            ),
            eq(pgSchema.memoryReviewRequestsPostgres.status, 'pending_review'),
          ),
        )
        .orderBy(desc(pgSchema.memoryReviewRequestsPostgres.createdAt))
        .limit(20),
  )) as MemoryReviewRow[];
  return rows.map(toMemoryReview);
}
export async function createPendingMemoryReview(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  phase: DreamingRunStatus['phase'];
  proposal: MemoryLifecycleProposal;
}): Promise<string> {
  const validation = await validateMemoryReviewProposal({
    db: input.db,
    subject: input.subject,
    proposal: input.proposal,
  });
  if (!validation.ok) return '';
  const now = nowIso();
  const id = `mrv_${randomUUID().replace(/-/g, '')}`;
  await input.db.insert(pgSchema.memoryReviewRequestsPostgres).values({
    id,
    runId: input.runId,
    appId: input.subject.appId,
    agentId: input.subject.agentId,
    subjectType: input.subject.subjectType,
    subjectId: input.subject.subjectId,
    threadId: input.subject.threadId ?? null,
    phase: input.phase,
    proposalJson: JSON.stringify(input.proposal),
    itemVersionsJson: JSON.stringify(validation.itemVersions),
    candidateVersionsJson: JSON.stringify(validation.candidateVersions),
    status: 'pending_review',
    validationSummary: validation.reason,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
export async function decideMemoryReview(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  decision: MemoryReviewDecisionInput;
  save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
  patch: (value: PatchAppMemoryInput) => Promise<AppMemoryItem>;
  delete: (value: DeleteAppMemoryInput) => Promise<{ deleted: boolean }>;
}): Promise<MemoryReviewRecord> {
  const rows = await input.db
    .select()
    .from(pgSchema.memoryReviewRequestsPostgres)
    .where(
      and(
        eq(pgSchema.memoryReviewRequestsPostgres.id, input.decision.reviewId),
        eq(pgSchema.memoryReviewRequestsPostgres.status, 'pending_review'),
        eq(pgSchema.memoryReviewRequestsPostgres.appId, input.subject.appId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('pending memory review not found');
  const review = toMemoryReview(row);
  if (
    review.agentId !== input.subject.agentId ||
    review.subjectType !== input.subject.subjectType ||
    review.subjectId !== input.subject.subjectId ||
    (review.threadId || undefined) !== (input.subject.threadId || undefined)
  ) {
    throw new Error('memory review is outside trusted subject scope');
  }
  const now = nowIso();
  if (input.decision.decision === 'reject') {
    const [updated] = await input.db
      .update(pgSchema.memoryReviewRequestsPostgres)
      .set({
        status: 'rejected',
        decision: 'reject',
        reviewerId: input.decision.reviewerId ?? null,
        applyOutcome: 'rejected by reviewer',
        updatedAt: now,
        decidedAt: now,
      })
      .where(eq(pgSchema.memoryReviewRequestsPostgres.id, review.id))
      .returning();
    return toMemoryReview(updated!);
  }
  const proposal: MemoryLifecycleProposal = {
    ...review.proposal,
    ...(input.decision.decision === 'edit_approve' &&
    input.decision.editedValue !== undefined
      ? { value: input.decision.editedValue }
      : {}),
    ...(input.decision.decision === 'edit_approve' &&
    input.decision.editedReason !== undefined
      ? { reason: input.decision.editedReason }
      : {}),
  };
  const validation = await validateMemoryReviewProposal({
    db: input.db,
    subject: input.subject,
    proposal,
    expectedItemVersions: review.itemVersions,
    expectedCandidateVersions: review.candidateVersions,
  });
  if (!validation.ok) {
    const [updated] = await input.db
      .update(pgSchema.memoryReviewRequestsPostgres)
      .set({
        status: 'failed',
        decision: input.decision.decision,
        reviewerId: input.decision.reviewerId ?? null,
        editedValue: input.decision.editedValue ?? null,
        editedReason: input.decision.editedReason ?? null,
        applyOutcome: validation.reason,
        updatedAt: now,
        decidedAt: now,
      })
      .where(eq(pgSchema.memoryReviewRequestsPostgres.id, review.id))
      .returning();
    return toMemoryReview(updated!);
  }
  const outcome = await applyMemoryReviewProposal({
    db: input.db,
    subject: input.subject,
    proposal,
    itemVersions: validation.itemVersions,
    save: input.save,
    patch: input.patch,
    delete: input.delete,
  });
  const [updated] = await input.db
    .update(pgSchema.memoryReviewRequestsPostgres)
    .set({
      status: outcome.applied ? 'applied' : 'failed',
      decision: input.decision.decision,
      reviewerId: input.decision.reviewerId ?? null,
      editedValue: input.decision.editedValue ?? null,
      editedReason: input.decision.editedReason ?? null,
      applyOutcome: outcome.reason,
      updatedAt: now,
      decidedAt: now,
    })
    .where(eq(pgSchema.memoryReviewRequestsPostgres.id, review.id))
    .returning();
  return toMemoryReview(updated!);
}
async function validateMemoryReviewProposal(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  proposal: MemoryLifecycleProposal;
  expectedItemVersions?: Record<string, number>;
  expectedCandidateVersions?: Record<string, string>;
}): Promise<{
  ok: boolean;
  reason: string;
  itemVersions: Record<string, number>;
  candidateVersions: Record<string, string>;
}> {
  const proposal = input.proposal;
  if (!REVIEW_APPLYABLE_ACTIONS.has(proposal.action)) {
    return failure('proposal action is not supported for memory review');
  }
  if (proposal.action === 'retire' && !proposal.itemId) {
    return failure('retire proposal requires a target memory item');
  }
  if (
    proposal.action === 'promote' &&
    (!proposal.candidateId ||
      !proposal.kind ||
      !proposal.key ||
      !proposal.value)
  ) {
    return failure(
      'promote proposal requires a candidate, kind, key, and value',
    );
  }
  if (
    (proposal.action === 'rewrite' || proposal.action === 'needs_review') &&
    (!proposal.itemId || !proposal.value)
  ) {
    return failure(
      'rewrite proposal requires a target item and replacement value',
    );
  }
  if (proposal.action === 'merge') {
    const itemIds = proposal.itemIds || [];
    if (
      !proposal.targetItemId ||
      itemIds.length < 2 ||
      !itemIds.includes(proposal.targetItemId)
    ) {
      return failure(
        'merge proposal requires multiple item ids including the target item',
      );
    }
  }
  if (proposal.confidence < 0.6) {
    return failure('proposal confidence is below review threshold');
  }
  if (!proposal.evidenceIds.length) {
    return failure('proposal is missing evidence ids');
  }
  for (const value of [proposal.key, proposal.value, proposal.reason]) {
    if (!value) continue;
    const sensitiveReason = classifySensitiveMemoryMaterial(value);
    if (sensitiveReason) {
      return failure(
        `proposal contains sensitive material: ${sensitiveReason}`,
      );
    }
  }
  if (
    proposal.kind &&
    !['preference', 'decision', 'fact', 'correction', 'constraint'].includes(
      proposal.kind,
    )
  ) {
    return failure('proposal uses unsupported memory kind');
  }
  const evidenceRows = await input.db
    .select()
    .from(pgSchema.memoryEvidencePostgres)
    .where(inArray(pgSchema.memoryEvidencePostgres.id, proposal.evidenceIds));
  if (evidenceRows.length !== new Set(proposal.evidenceIds).size) {
    return failure('proposal references missing evidence');
  }
  for (const evidence of evidenceRows) {
    const metadata = parseJsonObject(evidence.metadataJson);
    if (
      metadata.unsafeSource === true ||
      metadata.quarantined === true ||
      metadata.promptInjection === true ||
      metadata.safety === 'unsafe' ||
      metadata.safety === 'quarantined'
    ) {
      return failure(
        'proposal references quarantined or unsafe Memory Source evidence',
      );
    }
    if (
      evidence.appId !== input.subject.appId ||
      evidence.agentId !== input.subject.agentId ||
      evidence.subjectType !== input.subject.subjectType ||
      evidence.subjectId !== input.subject.subjectId ||
      (evidence.threadId || undefined) !== (input.subject.threadId || undefined)
    ) {
      return failure('proposal evidence is outside subject scope');
    }
  }
  if (
    proposal.value &&
    !isValueGroundedInEvidence(proposal.value, evidenceRows)
  ) {
    return failure('proposal value is not grounded in cited evidence');
  }
  const itemIds = [
    proposal.itemId,
    proposal.targetItemId,
    ...(proposal.itemIds || []),
  ].filter((id): id is string => Boolean(id));
  const itemVersions: Record<string, number> = {};
  if (itemIds.length) {
    const itemRows = await input.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(inArray(pgSchema.memoryItemsPostgres.id, itemIds));
    if (itemRows.length !== new Set(itemIds).size) {
      return {
        ...failure('proposal references missing memory item'),
        itemVersions,
      };
    }
    for (const item of itemRows) {
      if (!itemMatchesSubjectBoundary(item, input.subject)) {
        return {
          ...failure('proposal item is outside subject scope'),
          itemVersions,
        };
      }
      const version = parseItemSource(item).version;
      itemVersions[item.id] = version;
      if (
        input.expectedItemVersions &&
        input.expectedItemVersions[item.id] !== version
      ) {
        return {
          ...failure('proposal target memory item version is stale'),
          itemVersions,
        };
      }
    }
  }
  const candidateVersions: Record<string, string> = {};
  if (proposal.candidateId) {
    const candidateRows = await input.db
      .select()
      .from(pgSchema.memoryCandidatesPostgres)
      .where(eq(pgSchema.memoryCandidatesPostgres.id, proposal.candidateId))
      .limit(1);
    const candidate = candidateRows[0];
    if (!candidate) {
      return {
        ...failure('proposal references missing candidate'),
        itemVersions,
      };
    }
    if (
      candidate.appId !== input.subject.appId ||
      candidate.agentId !== input.subject.agentId ||
      candidate.subjectType !== input.subject.subjectType ||
      candidate.subjectId !== input.subject.subjectId ||
      (candidate.threadId || undefined) !==
        (input.subject.threadId || undefined)
    ) {
      return {
        ...failure('proposal candidate is outside subject scope'),
        itemVersions,
      };
    }
    candidateVersions[candidate.id] = candidate.updatedAt;
    if (
      input.expectedCandidateVersions &&
      input.expectedCandidateVersions[candidate.id] !== candidate.updatedAt
    ) {
      return {
        ...failure('proposal candidate version is stale'),
        itemVersions,
        candidateVersions,
      };
    }
  }
  return {
    ok: true,
    reason: 'proposal passed host validation',
    itemVersions,
    candidateVersions,
  };
}
async function applyMemoryReviewProposal(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  proposal: MemoryLifecycleProposal;
  itemVersions: Record<string, number>;
  save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
  patch: (value: PatchAppMemoryInput) => Promise<AppMemoryItem>;
  delete: (value: DeleteAppMemoryInput) => Promise<{ deleted: boolean }>;
}): Promise<{ applied: boolean; reason: string }> {
  const { subject, proposal } = input;
  if (proposal.action === 'promote') {
    const { candidateId, kind, key, value } = proposal;
    if (!candidateId || !kind || !key || !value) {
      return { applied: false, reason: 'reviewed promote proposal is invalid' };
    }
    const saved = await input.save({
      ...subject,
      kind,
      key,
      value,
      why: proposal.reason,
      confidence: proposal.confidence,
      evidenceIds: proposal.evidenceIds,
      isAdminWrite: subject.subjectType === 'common',
    });
    await input.db
      .update(pgSchema.memoryCandidatesPostgres)
      .set({ status: 'promoted', updatedAt: nowIso() })
      .where(eq(pgSchema.memoryCandidatesPostgres.id, candidateId));
    return {
      applied: true,
      reason: `promoted reviewed memory candidate into ${saved.id}`,
    };
  }
  if (proposal.action === 'retire' && proposal.itemId) {
    const result = await input.delete({
      ...subject,
      id: proposal.itemId,
      expectedVersion: input.itemVersions[proposal.itemId],
      isAdminWrite: subject.subjectType === 'common',
    });
    return {
      applied: result.deleted,
      reason: result.deleted
        ? 'retired reviewed memory item'
        : 'reviewed memory item was not deleted',
    };
  }
  if (
    proposal.action === 'merge' &&
    proposal.targetItemId &&
    proposal.itemIds?.length
  ) {
    const retiredIds = proposal.itemIds.filter(
      (id) => id !== proposal.targetItemId,
    );
    try {
      await input.db.transaction(async (tx) => {
        for (const id of retiredIds) {
          const expectedVersion = input.itemVersions[id];
          if (expectedVersion === undefined) {
            throw new Error(`missing expected version for merge item ${id}`);
          }
          const [deleted] = await tx
            .update(pgSchema.memoryItemsPostgres)
            .set({ status: 'deleted', updatedAt: nowIso() })
            .where(
              and(
                eq(pgSchema.memoryItemsPostgres.id, id),
                eq(pgSchema.memoryItemsPostgres.status, 'active'),
                sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}->>'version')::int = ${expectedVersion}`,
              ),
            )
            .returning({ id: pgSchema.memoryItemsPostgres.id });
          if (!deleted) {
            throw new Error(`merge item ${id} is stale or already inactive`);
          }
        }
      });
    } catch (err) {
      return {
        applied: false,
        reason:
          err instanceof Error
            ? err.message
            : 'reviewed merge failed before applying all duplicate retirements',
      };
    }
    return {
      applied: true,
      reason: `merged reviewed memory items into ${proposal.targetItemId}; retired ${retiredIds.length} duplicate item(s)`,
    };
  }
  if (
    (proposal.action === 'rewrite' || proposal.action === 'needs_review') &&
    proposal.itemId &&
    proposal.value
  ) {
    const patched = await input.patch({
      ...subject,
      id: proposal.itemId,
      expectedVersion: input.itemVersions[proposal.itemId],
      value: proposal.value,
      why: proposal.reason,
      isAdminWrite: subject.subjectType === 'common',
    });
    return {
      applied: true,
      reason: `rewrote reviewed memory item ${patched.id}`,
    };
  }
  return {
    applied: false,
    reason: `review proposal action ${proposal.action} is not applyable`,
  };
}
function failure(reason: string): {
  ok: false;
  reason: string;
  itemVersions: Record<string, number>;
  candidateVersions: Record<string, string>;
} {
  return {
    ok: false,
    reason,
    itemVersions: {},
    candidateVersions: {},
  };
}

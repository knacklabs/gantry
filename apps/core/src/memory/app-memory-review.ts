import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { classifySensitiveMemoryMaterial } from '../shared/sensitive-material.js';
import {
  itemMatchesSubjectBoundary,
  parseItemSource,
  parseJsonObject,
} from './app-memory-canonical-codec.js';
import {
  normalizePendingReviewLimit,
  normalizePendingReviewOffset,
  reviewEvidenceIds,
  reviewItemIds,
  toMemoryReviewDisplayPage,
  toMemoryReviewEvidenceSnippet,
  toReadableReviewItem,
  withProposedChanges,
} from './app-memory-review-readable.js';
import { isValueGroundedInEvidence } from './app-memory-review-grounding.js';
import { toMemoryReview } from './app-memory-review-record.js';
import {
  nowIso,
  withStatementTimeout,
} from './app-memory-service-query-helpers.js';
import type {
  AppMemoryItem,
  DeleteAppMemoryInput,
  MemoryLifecycleProposal,
  MemoryReviewDecisionInput,
  MemoryReviewEvidenceSnippet,
  MemoryReviewPage,
  MemoryReviewReadableItem,
  MemoryReviewRecord,
  NormalizedMemorySubject,
  PatchAppMemoryInput,
  SaveAppMemoryInput,
} from './memory-types.js';
type Db = NodePgDatabase<typeof pgSchema>;
type MemoryReviewRow =
  typeof pgSchema.memoryReviewRequestsPostgres.$inferSelect;
type MemoryItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
type MemoryEvidenceRow = typeof pgSchema.memoryEvidencePostgres.$inferSelect;
const REVIEW_APPLYABLE_ACTIONS = new Set(
  'promote retire rewrite merge needs_review'.split(' '),
);
function pendingMemoryReviewFilter(subject: NormalizedMemorySubject) {
  return and(
    eq(pgSchema.memoryReviewRequestsPostgres.appId, subject.appId),
    eq(pgSchema.memoryReviewRequestsPostgres.agentId, subject.agentId),
    eq(pgSchema.memoryReviewRequestsPostgres.subjectType, subject.subjectType),
    eq(pgSchema.memoryReviewRequestsPostgres.subjectId, subject.subjectId),
    eq(pgSchema.memoryReviewRequestsPostgres.status, 'pending_review'),
  );
}
async function itemMapForReviews(
  db: Db,
  reviews: MemoryReviewRecord[],
  statementTimeoutMs?: number,
): Promise<Map<string, MemoryReviewReadableItem>> {
  const itemIds = [
    ...new Set(reviews.flatMap((review) => reviewItemIds(review.proposal))),
  ];
  if (!itemIds.length) return new Map();
  const rows = (await withStatementTimeout(
    db,
    statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (tx) =>
      tx
        .select()
        .from(pgSchema.memoryItemsPostgres)
        .where(inArray(pgSchema.memoryItemsPostgres.id, itemIds)),
  )) as MemoryItemRow[];
  return new Map(rows.map((row) => [row.id, toReadableReviewItem(row)]));
}
async function evidenceMapForReviews(
  db: Db,
  subject: NormalizedMemorySubject,
  reviews: MemoryReviewRecord[],
  statementTimeoutMs?: number,
): Promise<Map<string, MemoryReviewEvidenceSnippet>> {
  const evidenceIds = reviewEvidenceIds(reviews);
  if (!evidenceIds.length) return new Map();
  const rows = (await withStatementTimeout(
    db,
    statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (tx) =>
      tx
        .select()
        .from(pgSchema.memoryEvidencePostgres)
        .where(
          and(
            inArray(pgSchema.memoryEvidencePostgres.id, evidenceIds),
            eq(pgSchema.memoryEvidencePostgres.appId, subject.appId),
            eq(pgSchema.memoryEvidencePostgres.agentId, subject.agentId),
            eq(
              pgSchema.memoryEvidencePostgres.subjectType,
              subject.subjectType,
            ),
            eq(pgSchema.memoryEvidencePostgres.subjectId, subject.subjectId),
          ),
        ),
  )) as MemoryEvidenceRow[];
  return new Map(
    rows.map((row) => [row.id, toMemoryReviewEvidenceSnippet(row)]),
  );
}
export async function countPendingMemoryReviews(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  statementTimeoutMs?: number;
}): Promise<number> {
  const rows = (await withStatementTimeout(
    input.db,
    input.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(pgSchema.memoryReviewRequestsPostgres)
        .where(pendingMemoryReviewFilter(input.subject))
        .limit(1),
  )) as Array<{ count: number | string | null }>;
  const count = Number(rows[0]?.count ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}
export async function listPendingMemoryReviews(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  statementTimeoutMs?: number;
  limit?: number;
  offset?: number;
}): Promise<MemoryReviewRecord[]> {
  const limit = normalizePendingReviewLimit(input.limit);
  const offset = normalizePendingReviewOffset(input.offset);
  const rows = (await withStatementTimeout(
    input.db,
    input.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (db) => {
      const query = db
        .select()
        .from(pgSchema.memoryReviewRequestsPostgres)
        .where(pendingMemoryReviewFilter(input.subject))
        .orderBy(desc(pgSchema.memoryReviewRequestsPostgres.createdAt))
        .limit(limit);
      return offset > 0 ? query.offset(offset) : query;
    },
  )) as MemoryReviewRow[];
  const reviews = rows.map(toMemoryReview);
  const itemsById = await itemMapForReviews(
    input.db,
    reviews,
    input.statementTimeoutMs,
  );
  return withProposedChanges(reviews, itemsById);
}
export async function listPendingMemoryReviewPage(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  statementTimeoutMs?: number;
  limit?: number;
  offset?: number;
}): Promise<MemoryReviewPage> {
  const limit = normalizePendingReviewLimit(input.limit);
  const offset = normalizePendingReviewOffset(input.offset);
  const totalCount = await countPendingMemoryReviews({
    db: input.db,
    subject: input.subject,
    statementTimeoutMs: input.statementTimeoutMs,
  });
  const reviews = await listPendingMemoryReviews({
    db: input.db,
    subject: input.subject,
    statementTimeoutMs: input.statementTimeoutMs,
    limit,
    offset,
  });
  const returnedCount = reviews.length;
  const nextOffset = offset + returnedCount;
  const evidenceById = await evidenceMapForReviews(
    input.db,
    input.subject,
    reviews,
    input.statementTimeoutMs,
  );
  return {
    reviews,
    reviewPage: toMemoryReviewDisplayPage({
      reviews,
      subject: input.subject,
      totalCount,
      returnedCount,
      remainingCount: Math.max(0, totalCount - nextOffset),
      limit,
      offset,
      nextOffset: nextOffset < totalCount ? nextOffset : null,
      evidenceById,
    }),
    totalCount,
    returnedCount,
    remainingCount: Math.max(0, totalCount - nextOffset),
    limit,
    offset,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
  };
}
export async function decideMemoryReview(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  decision: MemoryReviewDecisionInput;
  save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
  patch: (value: PatchAppMemoryInput) => Promise<AppMemoryItem>;
  delete: (value: DeleteAppMemoryInput) => Promise<{ deleted: boolean }>;
}): Promise<MemoryReviewRecord> {
  const now = nowIso();
  const reviewerFields = {
    decision: input.decision.decision,
    reviewerId: input.decision.reviewerId ?? null,
    editedValue: input.decision.editedValue ?? null,
    editedReason: input.decision.editedReason ?? null,
    updatedAt: now,
    decidedAt: now,
  };
  if (input.decision.decision === 'reject') {
    const [updated] = await input.db
      .update(pgSchema.memoryReviewRequestsPostgres)
      .set({
        status: 'rejected',
        ...reviewerFields,
        applyOutcome: 'rejected by reviewer',
      })
      .where(
        and(
          eq(pgSchema.memoryReviewRequestsPostgres.id, input.decision.reviewId),
          pendingMemoryReviewFilter(input.subject),
        ),
      )
      .returning();
    if (!updated) throw new Error('pending memory review not found');
    return toMemoryReview(updated);
  }
  const [claimed] = await input.db
    .update(pgSchema.memoryReviewRequestsPostgres)
    .set({
      status: 'approved',
      ...reviewerFields,
      applyOutcome: 'review decision claimed for application',
    })
    .where(
      and(
        eq(pgSchema.memoryReviewRequestsPostgres.id, input.decision.reviewId),
        pendingMemoryReviewFilter(input.subject),
      ),
    )
    .returning();
  if (!claimed) throw new Error('pending memory review not found');
  const review = toMemoryReview(claimed);
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
      .where(
        and(
          eq(pgSchema.memoryReviewRequestsPostgres.id, review.id),
          eq(pgSchema.memoryReviewRequestsPostgres.status, 'approved'),
        ),
      )
      .returning();
    if (!updated) throw new Error('memory review decision claim was lost');
    return toMemoryReview(updated);
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
    .where(
      and(
        eq(pgSchema.memoryReviewRequestsPostgres.id, review.id),
        eq(pgSchema.memoryReviewRequestsPostgres.status, 'approved'),
      ),
    )
    .returning();
  if (!updated) throw new Error('memory review decision claim was lost');
  return toMemoryReview(updated);
}
export async function validateMemoryReviewProposal(input: {
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
  contentFingerprint?: string;
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
      evidence.subjectId !== input.subject.subjectId
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
  const fingerprintParts: string[] = [];
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
    for (const item of itemRows
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))) {
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
      const payload = parseJsonObject(item.valueJson);
      const itemValue = typeof payload.value === 'string' ? payload.value : '';
      fingerprintParts.push(
        `item:${item.id}:${item.kind}:${item.key}:${itemValue}`,
      );
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
      candidate.subjectId !== input.subject.subjectId
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
    fingerprintParts.push(
      `candidate:${candidate.id}:${candidate.kind}:${candidate.key}:${candidate.value}`,
    );
  }
  if (fingerprintParts.length === 0) {
    fingerprintParts.push(
      `proposal:${proposal.key ?? ''}:${proposal.value ?? ''}`,
    );
  }
  // Fingerprint of the flagged content (not the proposal's suggested rewrite)
  // plus the proposal action: identical content re-detected by any dreaming
  // pass hashes to the same value, so review creation can dedupe against
  // pending and already-decided reviews.
  const contentFingerprint = createHash('sha256')
    .update(`${proposal.action}\n${fingerprintParts.join('\n')}`)
    .digest('hex');
  return {
    ok: true,
    reason: 'proposal passed host validation',
    itemVersions,
    candidateVersions,
    contentFingerprint,
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
  return { ok: false, reason, itemVersions: {}, candidateVersions: {} };
}

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import {
  parseItemSource,
  parseJsonObject,
} from './app-memory-canonical-codec.js';
import { validateMemoryReviewProposal } from './app-memory-review.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import type {
  DreamingRunStatus,
  MemoryContradiction,
  MemoryLifecycleProposal,
  MemoryReviewSnapshot,
  MemoryReviewSnapshotEvidence,
  NormalizedMemorySubject,
} from './memory-types.js';

export type MemoryReviewDb = Parameters<
  typeof validateMemoryReviewProposal
>[0]['db'];
type Db = MemoryReviewDb;

export type CreateMemoryReviewOutcome = {
  status: 'created' | 'pending_exists' | 'adjudicated' | 'invalid';
  reviewId: string;
  reason?: string;
};

async function captureCurrentItemClaim(
  db: Db,
  itemId: string | undefined,
  // When omitted, the claim's evidence ids come from the item's own source
  // (used for merge participants, which carry their own grounding).
  evidenceIds?: string[],
): Promise<MemoryContradiction['active'] | null> {
  if (!itemId) return null;
  const rows = await db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(eq(pgSchema.memoryItemsPostgres.id, itemId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const value = parseJsonObject(row.valueJson).value;
  return {
    itemId: row.id,
    kind: row.kind,
    key: row.key,
    value: typeof value === 'string' ? value : '',
    evidenceIds: evidenceIds ?? parseItemSource(row).evidenceIds,
  };
}

async function captureSnapshotEvidence(
  db: Db,
  subject: NormalizedMemorySubject,
  roleById: Map<string, 'active' | 'incoming'>,
): Promise<MemoryReviewSnapshotEvidence[]> {
  const ids = [...roleById.keys()];
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(pgSchema.memoryEvidencePostgres)
    .where(
      and(
        inArray(pgSchema.memoryEvidencePostgres.id, ids),
        eq(pgSchema.memoryEvidencePostgres.appId, subject.appId),
        eq(pgSchema.memoryEvidencePostgres.agentId, subject.agentId),
        eq(pgSchema.memoryEvidencePostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryEvidencePostgres.subjectId, subject.subjectId),
      ),
    );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => rowById.get(id))
    .filter((row): row is (typeof rows)[number] => Boolean(row))
    .map((row) => ({
      id: row.id,
      role: roleById.get(row.id) ?? 'active',
      sourceType: row.sourceType,
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
      // sourceUri: whatever the evidence row carries; null when absent.
      // ponytail: no URI-derivation from sourceType/sourceId here (T4+ scope).
      ...(row.sourceUri ? { sourceUri: row.sourceUri } : {}),
      text: row.text,
      capturedAt: row.createdAt,
    }));
}

/**
 * Freeze what a reviewer must see the moment a review is created: the current
 * claim(s), the proposed canonical, every merge participant, and every cited
 * evidence row (text + sourceUri). Display renders from this so it never drifts
 * as items/evidence mutate. Applying still re-validates live versions.
 *
 * Fails closed: if any cited evidence id (or merge participant) cannot be
 * captured, no inconsistent snapshot is written — creation is rejected.
 */
async function buildReviewSnapshot(
  db: Db,
  subject: NormalizedMemorySubject,
  proposal: MemoryLifecycleProposal,
): Promise<
  { ok: true; snapshot: MemoryReviewSnapshot } | { ok: false; reason: string }
> {
  const roleById = new Map<string, 'active' | 'incoming'>();
  const addRoles = (ids: string[] | undefined, role: 'active' | 'incoming') => {
    for (const id of ids || []) if (!roleById.has(id)) roleById.set(id, role);
  };

  let conflict: MemoryReviewSnapshot['conflict'];
  let proposedCanonical: MemoryReviewSnapshot['proposedCanonical'];
  let retiring: MemoryReviewSnapshot['retiring'];

  if (proposal.contradiction) {
    const c = proposal.contradiction;
    conflict = { active: c.active, incoming: c.incoming };
    proposedCanonical = c.proposedCanonical;
    addRoles(c.incoming.evidenceIds, 'incoming');
    addRoles(c.active.evidenceIds, 'active');
    addRoles(c.proposedCanonical.evidenceIds, 'active');
    addRoles(proposal.evidenceIds, 'active');
  } else if (proposal.action === 'merge') {
    // Capture the target AND every retiring sibling so a reviewer sees exactly
    // what disappears, frozen against later edits to those items. The target
    // keeps its OWN source evidence (like the participants); the merge-level
    // proposal.evidenceIds are added separately below.
    const target = await captureCurrentItemClaim(db, proposal.targetItemId);
    if (!target) {
      return {
        ok: false,
        reason: 'merge target item could not be captured',
      };
    }
    conflict = { active: target };
    addRoles(target.evidenceIds, 'active');
    const retiringIds = (proposal.itemIds || []).filter(
      (id) => id !== proposal.targetItemId,
    );
    const captured: MemoryContradiction['active'][] = [];
    for (const id of retiringIds) {
      const claim = await captureCurrentItemClaim(db, id);
      if (!claim) {
        return {
          ok: false,
          reason: `review snapshot could not capture retiring merge item ${id}`,
        };
      }
      captured.push(claim);
      addRoles(claim.evidenceIds, 'active');
    }
    if (captured.length) retiring = captured;
    addRoles(proposal.evidenceIds, 'active');
  } else {
    // Single-sided review: capture the current target claim (before) and, for
    // rewrite/needs_review, the proposed after.
    const before = await captureCurrentItemClaim(
      db,
      proposal.itemId || proposal.targetItemId,
      proposal.evidenceIds,
    );
    if (before) conflict = { active: before };
    if (proposal.action !== 'retire') {
      proposedCanonical = {
        kind: proposal.kind ?? before?.kind ?? '',
        key: proposal.key ?? before?.key ?? '',
        value: proposal.value ?? '',
        reason: proposal.reason,
        evidenceIds: proposal.evidenceIds,
      };
    }
    addRoles(proposal.evidenceIds, 'active');
  }

  const evidence = await captureSnapshotEvidence(db, subject, roleById);
  if (evidence.length !== roleById.size) {
    const captured = new Set(evidence.map((e) => e.id));
    const missing = [...roleById.keys()].filter((id) => !captured.has(id));
    return {
      ok: false,
      reason: `review snapshot is missing cited evidence: ${missing.join(', ')}`,
    };
  }

  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      subject: {
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      },
      ...(conflict ? { conflict } : {}),
      ...(proposedCanonical ? { proposedCanonical } : {}),
      ...(retiring ? { retiring } : {}),
      evidence,
    },
  };
}

export async function createPendingMemoryReview(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  phase: DreamingRunStatus['phase'];
  proposal: MemoryLifecycleProposal;
}): Promise<CreateMemoryReviewOutcome> {
  const validation = await validateMemoryReviewProposal({
    db: input.db,
    subject: input.subject,
    proposal: input.proposal,
  });
  if (!validation.ok) {
    return { status: 'invalid', reviewId: '', reason: validation.reason };
  }
  const contentFingerprint = validation.contentFingerprint ?? '';
  if (contentFingerprint) {
    // Never open a second review for content that already has one: a pending
    // review absorbs repeat detections, and a decided review means a human
    // already adjudicated this exact content — re-flagging it every dreaming
    // run would loop forever. Changed content produces a new fingerprint and
    // legitimately reviews again.
    const duplicates = await input.db
      .select({
        id: pgSchema.memoryReviewRequestsPostgres.id,
        status: pgSchema.memoryReviewRequestsPostgres.status,
      })
      .from(pgSchema.memoryReviewRequestsPostgres)
      .where(
        and(
          eq(pgSchema.memoryReviewRequestsPostgres.appId, input.subject.appId),
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
          eq(
            pgSchema.memoryReviewRequestsPostgres.flaggedContentHash,
            contentFingerprint,
          ),
        ),
      )
      .limit(20);
    const pending = duplicates.find((row) => row.status === 'pending_review');
    if (pending) return { status: 'pending_exists', reviewId: pending.id };
    const decided = duplicates[0];
    if (decided) return { status: 'adjudicated', reviewId: decided.id };
  }
  const snapshotResult = await buildReviewSnapshot(
    input.db,
    input.subject,
    input.proposal,
  );
  if (!snapshotResult.ok) {
    return { status: 'invalid', reviewId: '', reason: snapshotResult.reason };
  }
  const now = nowIso();
  const id = `mrv_${randomUUID().replace(/-/g, '')}`;
  await input.db.insert(pgSchema.memoryReviewRequestsPostgres).values({
    id,
    runId: input.runId,
    appId: input.subject.appId,
    agentId: input.subject.agentId,
    subjectType: input.subject.subjectType,
    subjectId: input.subject.subjectId,
    threadId: null,
    phase: input.phase,
    proposalJson: JSON.stringify(input.proposal),
    itemVersionsJson: JSON.stringify(validation.itemVersions),
    candidateVersionsJson: JSON.stringify(validation.candidateVersions),
    reviewSnapshotJson: JSON.stringify(snapshotResult.snapshot),
    status: 'pending_review',
    validationSummary: validation.reason,
    flaggedContentHash: contentFingerprint || null,
    createdAt: now,
    updatedAt: now,
  });
  return { status: 'created', reviewId: id };
}

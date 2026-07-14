import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { validateMemoryReviewProposal } from './app-memory-review.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import type {
  DreamingRunStatus,
  MemoryLifecycleProposal,
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
    status: 'pending_review',
    validationSummary: validation.reason,
    flaggedContentHash: contentFingerprint || null,
    createdAt: now,
    updatedAt: now,
  });
  return { status: 'created', reviewId: id };
}

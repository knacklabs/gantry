import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import type {
  CreateMemoryReviewOutcome,
  MemoryReviewDb,
} from './app-memory-review-create.js';
import type {
  DreamDecisionAction,
  MemoryLifecycleProposal,
  NormalizedMemorySubject,
} from './memory-types.js';

type Db = MemoryReviewDb;

// prettier-ignore
export type CreatePendingReview = (p: MemoryLifecycleProposal, db?: Db) => Promise<CreateMemoryReviewOutcome>;

export async function setCandidateStatus(db: Db, id: string, status: string) {
  await db
    .update(pgSchema.memoryCandidatesPostgres)
    .set({ status, updatedAt: nowIso() })
    .where(eq(pgSchema.memoryCandidatesPostgres.id, id));
}

export async function recordDreamDecision(input: {
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

export async function routeMemoryProposalToReview(input: {
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
  let outcome: CreateMemoryReviewOutcome = { status: 'invalid', reviewId: '' };
  const createReview = async (
    db = input.db,
  ): Promise<CreateMemoryReviewOutcome> =>
    (await input.createPendingReview?.(input.proposal, db)) ?? {
      status: 'invalid',
      reviewId: '',
    };
  try {
    if (input.candidateId) {
      outcome = await input.db.transaction(async (tx) => {
        const created = await createReview(tx);
        if (
          created.status === 'created' ||
          created.status === 'pending_exists'
        ) {
          await setCandidateStatus(tx, input.candidateId!, 'needs_review');
        }
        if (created.status === 'invalid') {
          throw new Error('pending memory review creation returned empty id');
        }
        return created;
      });
    } else {
      outcome = await createReview();
    }
  } catch {
    outcome = { status: 'invalid', reviewId: '' };
  }
  if (outcome.status === 'adjudicated') {
    // A review for this exact content was already decided by a human; do not
    // re-open it. The proposal is journaled as skipped so runs stay auditable
    // without re-flagging adjudicated content forever.
    await recordDreamDecision({
      db: input.db,
      runId: input.runId,
      subject: input.subject,
      action: 'skip',
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      rationale: `${input.reviewRationale} — skipped: identical content was already reviewed (${outcome.reviewId}).`,
      ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
      applied: false,
    });
    return 'skip';
  }
  const reviewId =
    outcome.status === 'created' || outcome.status === 'pending_exists'
      ? outcome.reviewId
      : '';
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

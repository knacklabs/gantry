import { describe, expect, it } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { createPendingMemoryReview } from '@core/memory/app-memory-review-create.js';
import {
  getMemoryReviewDetail,
  listPendingMemoryReviewPage,
  listPendingMemoryReviews,
} from '@core/memory/app-memory-review.js';
import type {
  MemoryLifecycleProposal,
  NormalizedMemorySubject,
} from '@core/memory/memory-types.js';

const subject: NormalizedMemorySubject = {
  appId: 'app-a',
  agentId: 'agent-a',
  subjectType: 'user',
  subjectId: 'user-1',
};

function itemRow(input: {
  id: string;
  kind: string;
  key: string;
  value: string;
}) {
  return {
    id: input.id,
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    userId: null,
    conversationId: null,
    threadId: null,
    kind: input.kind,
    key: input.key,
    valueJson: JSON.stringify({ value: input.value, why: null }),
    sourceRefJson: JSON.stringify({
      subject: {
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      },
      version: 1,
    }),
    confidence: 0.8,
    status: 'active',
    lastObservedAt: null,
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
  };
}

function evidenceRow(input: {
  id: string;
  text: string;
  sourceUri?: string | null;
}) {
  return {
    id: input.id,
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    userId: null,
    groupId: null,
    channelId: null,
    threadId: null,
    sourceType: 'session',
    sourceId: 'sess-1',
    sourceUri: input.sourceUri ?? null,
    actorId: 'user-1',
    text: input.text,
    metadataJson: '{}',
    createdAt: '2026-05-07T00:00:00.000Z',
  };
}

function candidateRow(input: {
  id: string;
  kind: string;
  key: string;
  value: string;
}) {
  return {
    id: input.id,
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    threadId: null,
    kind: input.kind,
    key: input.key,
    value: input.value,
    reason: 'candidate reason',
    metadataJson: '{}',
    evidenceIdsJson: '[]',
    confidence: 0.9,
    status: 'staged',
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
  };
}

interface Store {
  items: Map<string, ReturnType<typeof itemRow>>;
  evidence: Map<string, ReturnType<typeof evidenceRow>>;
  candidates: Map<string, ReturnType<typeof candidateRow>>;
  reviews: any[];
}

// Stateful table-keyed mock: selects read live store contents, insert appends a
// review row. Non-filtering by design — tests keep the evidence store equal to
// proposal.evidenceIds so validateMemoryReviewProposal's count check holds.
function makeDb(store: Store) {
  const rowsFor = (table: unknown): any[] => {
    if (table === pgSchema.memoryEvidencePostgres)
      return [...store.evidence.values()];
    if (table === pgSchema.memoryItemsPostgres)
      return [...store.items.values()];
    if (table === pgSchema.memoryCandidatesPostgres)
      return [...store.candidates.values()];
    if (table === pgSchema.memoryReviewRequestsPostgres)
      return [...store.reviews];
    return [];
  };
  const db: any = {
    select: (projection?: unknown) => ({
      from: (table: unknown) => {
        const isCount =
          projection && typeof projection === 'object' && 'count' in projection;
        const rows = isCount
          ? [{ count: rowsFor(table).length }]
          : rowsFor(table);
        const p = Promise.resolve(rows);
        return {
          where: () => ({
            then: (res: any, rej: any) => p.then(res, rej),
            limit: () => Promise.resolve(rows),
            orderBy: () => ({
              then: (res: any, rej: any) => p.then(res, rej),
              limit: () => Promise.resolve(rows),
              offset: () => Promise.resolve(rows),
            }),
          }),
        };
      },
    }),
    insert: () => ({
      values: (value: any) => {
        store.reviews.push(value);
        return { returning: async () => [value] };
      },
    }),
  };
  return db;
}

function emptyStore(): Store {
  return {
    items: new Map(),
    evidence: new Map(),
    candidates: new Map(),
    reviews: [],
  };
}

describe('memory review snapshot capture + immutable render', () => {
  it('captures a rewrite snapshot (current before + proposed after) at creation', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-1',
      itemRow({
        id: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'daily cadence review',
      }),
    );
    store.evidence.set(
      'mev-1',
      evidenceRow({
        id: 'mev-1',
        text: 'The weekly cadence review is confirmed.',
        sourceUri: 'https://src/mev-1',
      }),
    );
    const db = makeDb(store);
    const proposal: MemoryLifecycleProposal = {
      action: 'needs_review',
      itemId: 'mem-1',
      kind: 'fact',
      key: 'fact:cadence',
      value: 'weekly cadence review',
      reason: 'cadence changed',
      confidence: 0.9,
      evidenceIds: ['mev-1'],
    };

    const outcome = await createPendingMemoryReview({
      db,
      runId: 'run-1',
      subject,
      phase: 'deep',
      proposal,
    });
    expect(outcome.status).toBe('created');

    const snap = JSON.parse(store.reviews[0].reviewSnapshotJson);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.conflict.active.value).toBe('daily cadence review');
    expect(snap.conflict.incoming).toBeUndefined();
    expect(snap.proposedCanonical.value).toBe('weekly cadence review');
    expect(snap.evidence).toHaveLength(1);
    expect(snap.evidence[0]).toMatchObject({
      id: 'mev-1',
      role: 'active',
      sourceUri: 'https://src/mev-1',
      text: 'The weekly cadence review is confirmed.',
    });
  });

  it('captures a retire snapshot (before only, no proposed after)', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-2',
      itemRow({
        id: 'mem-2',
        kind: 'fact',
        key: 'fact:x',
        value: 'obsolete claim',
      }),
    );
    store.evidence.set(
      'mev-2',
      evidenceRow({ id: 'mev-2', text: 'obsolete claim was superseded' }),
    );
    const outcome = await createPendingMemoryReview({
      db: makeDb(store),
      runId: 'run-2',
      subject,
      phase: 'deep',
      proposal: {
        action: 'retire',
        itemId: 'mem-2',
        reason: 'stale',
        confidence: 0.9,
        evidenceIds: ['mev-2'],
      },
    });
    expect(outcome.status).toBe('created');
    const snap = JSON.parse(store.reviews[0].reviewSnapshotJson);
    expect(snap.conflict.active.value).toBe('obsolete claim');
    expect(snap.proposedCanonical).toBeUndefined();
    expect(snap.evidence[0].id).toBe('mev-2');
  });

  it('captures both claims for a contradiction proposal', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-3',
      itemRow({
        id: 'mem-3',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'daily cadence review',
      }),
    );
    store.candidates.set(
      'mca-1',
      candidateRow({
        id: 'mca-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'weekly cadence review',
      }),
    );
    store.evidence.set(
      'mev-inc',
      evidenceRow({
        id: 'mev-inc',
        text: 'The weekly cadence review is now canonical.',
        sourceUri: 'https://src/inc',
      }),
    );
    const proposal: MemoryLifecycleProposal = {
      action: 'needs_review',
      itemId: 'mem-3',
      candidateId: 'mca-1',
      kind: 'fact',
      key: 'fact:cadence',
      value: 'weekly cadence review',
      reason: 'canonical',
      confidence: 0.9,
      evidenceIds: ['mev-inc'],
      contradiction: {
        type: 'same_key_value_disagreement',
        active: {
          itemId: 'mem-3',
          kind: 'fact',
          key: 'fact:cadence',
          value: 'daily cadence review',
          evidenceIds: ['mev-act'],
        },
        incoming: {
          candidateId: 'mca-1',
          kind: 'fact',
          key: 'fact:cadence',
          value: 'weekly cadence review',
          evidenceIds: ['mev-inc'],
        },
        proposedCanonical: {
          kind: 'fact',
          key: 'fact:cadence',
          value: 'weekly cadence review',
          reason: 'canonical',
          evidenceIds: ['mev-inc'],
        },
      },
    };
    const outcome = await createPendingMemoryReview({
      db: makeDb(store),
      runId: 'run-3',
      subject,
      phase: 'deep',
      proposal,
    });
    expect(outcome.status).toBe('created');
    const snap = JSON.parse(store.reviews[0].reviewSnapshotJson);
    expect(snap.conflict.active.value).toBe('daily cadence review');
    expect(snap.conflict.incoming.value).toBe('weekly cadence review');
    expect(snap.proposedCanonical.value).toBe('weekly cadence review');
    // incoming-side evidence rides role 'incoming'.
    expect(snap.evidence.find((e: any) => e.id === 'mev-inc').role).toBe(
      'incoming',
    );
  });

  it('getReviewDetail returns captured values byte-for-byte after item + evidence mutate/delete', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-1',
      itemRow({
        id: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'daily cadence review',
      }),
    );
    store.evidence.set(
      'mev-1',
      evidenceRow({
        id: 'mev-1',
        text: 'The weekly cadence review is confirmed.',
        sourceUri: 'https://src/mev-1',
      }),
    );
    const db = makeDb(store);
    await createPendingMemoryReview({
      db,
      runId: 'run-1',
      subject,
      phase: 'deep',
      proposal: {
        action: 'needs_review',
        itemId: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'weekly cadence review',
        reason: 'cadence changed',
        confidence: 0.9,
        evidenceIds: ['mev-1'],
      },
    });
    const reviewId = store.reviews[0].id;

    // Mutate the live item and DELETE the evidence after the review exists.
    store.items.set(
      'mem-1',
      itemRow({
        id: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'MUTATED LIVE VALUE',
      }),
    );
    store.evidence.delete('mev-1');

    const detail = await getMemoryReviewDetail({ db, subject, reviewId });
    expect(detail).not.toBeNull();
    expect(detail!.reviewSnapshot!.conflict!.active.value).toBe(
      'daily cadence review',
    );
    expect(detail!.reviewSnapshot!.proposedCanonical!.value).toBe(
      'weekly cadence review',
    );
    expect(detail!.reviewSnapshot!.evidence[0].text).toBe(
      'The weekly cadence review is confirmed.',
    );
    expect(detail!.reviewSnapshot!.evidence[0].sourceUri).toBe(
      'https://src/mev-1',
    );
  });

  it('list preview renders before/after from the snapshot, not the mutated live item', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-1',
      itemRow({
        id: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'daily cadence review',
      }),
    );
    store.evidence.set(
      'mev-1',
      evidenceRow({
        id: 'mev-1',
        text: 'The weekly cadence review is confirmed.',
        sourceUri: 'u',
      }),
    );
    const db = makeDb(store);
    await createPendingMemoryReview({
      db,
      runId: 'run-1',
      subject,
      phase: 'deep',
      proposal: {
        action: 'needs_review',
        itemId: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'weekly cadence review',
        reason: 'cadence changed',
        confidence: 0.9,
        evidenceIds: ['mev-1'],
      },
    });
    store.items.set(
      'mem-1',
      itemRow({
        id: 'mem-1',
        kind: 'fact',
        key: 'fact:cadence',
        value: 'MUTATED',
      }),
    );

    const [review] = await listPendingMemoryReviews({ db, subject });
    expect(review.proposedChange!.before!.value).toBe('daily cadence review');
    expect(review.proposedChange!.after!.value).toBe('weekly cadence review');

    const page = await listPendingMemoryReviewPage({ db, subject });
    expect(page.reviewPage!.items[0].evidence[0].evidenceId).toBe('mev-1');
  });

  it('malformed snapshot falls back to legacy re-query render', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-9',
      itemRow({
        id: 'mem-9',
        kind: 'fact',
        key: 'fact:y',
        value: 'current live value',
      }),
    );
    store.reviews.push({
      id: 'mrv_legacy',
      runId: 'run-x',
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      threadId: null,
      phase: 'deep',
      proposalJson: JSON.stringify({
        action: 'needs_review',
        itemId: 'mem-9',
        value: 'proposed value',
        reason: 'r',
        confidence: 0.9,
        evidenceIds: [],
      }),
      itemVersionsJson: '{}',
      candidateVersionsJson: '{}',
      // schemaVersion 2 -> parseReviewSnapshot returns null -> legacy path.
      reviewSnapshotJson: '{"schemaVersion":2,"evidence":[]}',
      status: 'pending_review',
      validationSummary: 'ok',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    });

    const [review] = await listPendingMemoryReviews({
      db: makeDb(store),
      subject,
    });
    expect(review.reviewSnapshot).toBeNull();
    // Legacy fallback re-queries the live item, so before reflects current row.
    expect(review.proposedChange!.before!.value).toBe('current live value');
  });
});

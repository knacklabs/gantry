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
  MemoryReviewSnapshot,
  NormalizedMemorySubject,
} from '@core/memory/memory-types.js';

const subject: NormalizedMemorySubject = {
  appId: 'app-a',
  agentId: 'agent-a',
  subjectType: 'user',
  subjectId: 'user-1',
};

// Extract drizzle SQL param values so the mock can filter store rows by the ids
// a query actually constrains (mirrors the app-memory-dreaming test helper).
function collectSqlParamValues(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as { constructor?: { name?: string }; value?: unknown };
  if (record.constructor?.name === 'Param') return [record.value];
  // inArray(...) nests its values as a plain Array of Param nodes.
  if (Array.isArray(node)) return node.flatMap(collectSqlParamValues);
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) ? chunks.flatMap(collectSqlParamValues) : [];
}

function itemRow(input: {
  id: string;
  kind: string;
  key: string;
  value: string;
  evidenceIds?: string[];
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
      evidenceIds: input.evidenceIds ?? [],
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
  createdAt?: string;
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
    createdAt: input.createdAt ?? '2026-05-07T00:00:00.000Z',
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

// A pre-built review row (bypasses creation) for rendering-path tests.
function reviewRow(input: {
  id: string;
  proposal: MemoryLifecycleProposal;
  snapshot: MemoryReviewSnapshot | null;
}) {
  return {
    id: input.id,
    runId: 'run-x',
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    threadId: null,
    phase: 'deep',
    proposalJson: JSON.stringify(input.proposal),
    itemVersionsJson: '{}',
    candidateVersionsJson: '{}',
    reviewSnapshotJson: input.snapshot ? JSON.stringify(input.snapshot) : null,
    status: 'pending_review',
    validationSummary: 'ok',
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

// Stateful table-keyed mock. Non-review tables filter by id-in-params so a
// query only sees the rows it constrains (matching real SQL); the review table
// distinguishes dedupe (by flaggedContentHash), detail (by review id), and
// list/count (return all).
// vanishOnCapture simulates a concurrent delete between validation (which reads
// items via inArray, multi-id) and single-id capture reads: an item id that
// exists for multi-id queries but is gone for its single-id capture read.
function makeDb(store: Store, opts?: { vanishOnCapture?: string }) {
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
        const isReviews = table === pgSchema.memoryReviewRequestsPostgres;
        const isDedupe =
          isReviews &&
          projection &&
          typeof projection === 'object' &&
          'status' in projection &&
          !isCount;
        const resolve = (cond: unknown): any[] => {
          const all = rowsFor(table);
          if (isCount) return [{ count: all.length }];
          const params = collectSqlParamValues(cond);
          if (isReviews) {
            if (isDedupe)
              return all.filter((r) => params.includes(r.flaggedContentHash));
            const byId = all.filter((r) => params.includes(r.id));
            return byId.length ? byId : all;
          }
          if (
            table === pgSchema.memoryItemsPostgres &&
            opts?.vanishOnCapture &&
            params.length === 1 &&
            params[0] === opts.vanishOnCapture
          ) {
            return [];
          }
          return all.filter((r) => params.includes(r.id));
        };
        return {
          where: (cond: unknown) => {
            const rows = resolve(cond);
            const p = Promise.resolve(rows);
            return {
              then: (res: any, rej: any) => p.then(res, rej),
              limit: () => Promise.resolve(rows),
              orderBy: () => ({
                then: (res: any, rej: any) => p.then(res, rej),
                limit: () => Promise.resolve(rows),
                offset: () => Promise.resolve(rows),
              }),
            };
          },
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

function validSnapshot(input: {
  activeItemId: string;
  activeValue: string;
  afterValue: string;
  evidenceId: string;
  evidenceText: string;
  capturedAt?: string;
}): MemoryReviewSnapshot {
  return {
    schemaVersion: 1,
    subject: {
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    },
    conflict: {
      active: {
        itemId: input.activeItemId,
        kind: 'fact',
        key: 'fact:k',
        value: input.activeValue,
        evidenceIds: [input.evidenceId],
      },
    },
    proposedCanonical: {
      kind: 'fact',
      key: 'fact:k',
      value: input.afterValue,
      reason: 'r',
      evidenceIds: [input.evidenceId],
    },
    evidence: [
      {
        id: input.evidenceId,
        role: 'active',
        sourceType: 'session',
        text: input.evidenceText,
        capturedAt: input.capturedAt ?? '2026-05-07T00:00:00.000Z',
      },
    ],
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
    const outcome = await createPendingMemoryReview({
      db: makeDb(store),
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
    expect(outcome.status).toBe('created');
    const snap = JSON.parse(store.reviews[0].reviewSnapshotJson);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.conflict.active.value).toBe('daily cadence review');
    expect(snap.conflict.incoming).toBeUndefined();
    expect(snap.proposedCanonical.value).toBe('weekly cadence review');
    expect(snap.evidence).toEqual([
      {
        id: 'mev-1',
        role: 'active',
        sourceType: 'session',
        sourceId: 'sess-1',
        sourceUri: 'https://src/mev-1',
        text: 'The weekly cadence review is confirmed.',
        capturedAt: '2026-05-07T00:00:00.000Z',
      },
    ]);
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

  it('captures both claims + both evidence sides for a contradiction', async () => {
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
    // Active-side evidence must exist too, or creation fails closed.
    store.evidence.set(
      'mev-act',
      evidenceRow({
        id: 'mev-act',
        text: 'The daily cadence review was the prior claim.',
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
    // Every cited evidence id was captured (fail-closed invariant holds).
    const byId = Object.fromEntries(
      snap.evidence.map((e: any) => [e.id, e.role]),
    );
    expect(byId).toEqual({ 'mev-inc': 'incoming', 'mev-act': 'active' });
  });

  it('rejects creation when a cited evidence id cannot be captured (fail closed)', async () => {
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
      }),
    );
    // NOTE: mev-act (cited by contradiction.active) is intentionally absent.
    const outcome = await createPendingMemoryReview({
      db: makeDb(store),
      runId: 'run-4',
      subject,
      phase: 'deep',
      proposal: {
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
      },
    });
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('mev-act');
    expect(store.reviews).toHaveLength(0);
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

  it('captures ALL merge participants and freezes them against later item changes', async () => {
    const store = emptyStore();
    // Target carries its OWN source evidence (mev-t), distinct from merge-level.
    store.items.set(
      'mem-t',
      itemRow({
        id: 'mem-t',
        kind: 'fact',
        key: 'fact:k',
        value: 'canonical target',
        evidenceIds: ['mev-t'],
      }),
    );
    store.items.set(
      'mem-r1',
      itemRow({ id: 'mem-r1', kind: 'fact', key: 'fact:k', value: 'dup one' }),
    );
    store.items.set(
      'mem-r2',
      itemRow({ id: 'mem-r2', kind: 'fact', key: 'fact:k', value: 'dup two' }),
    );
    store.evidence.set(
      'mev-1',
      evidenceRow({ id: 'mev-1', text: 'merge grounding' }),
    );
    store.evidence.set(
      'mev-t',
      evidenceRow({ id: 'mev-t', text: 'target own grounding' }),
    );
    const db = makeDb(store);
    const outcome = await createPendingMemoryReview({
      db,
      runId: 'run-m',
      subject,
      phase: 'deep',
      proposal: {
        action: 'merge',
        targetItemId: 'mem-t',
        itemIds: ['mem-t', 'mem-r1', 'mem-r2'],
        reason: 'duplicates',
        confidence: 0.9,
        evidenceIds: ['mev-1'],
      },
    });
    expect(outcome.status).toBe('created');
    const reviewId = store.reviews[0].id;

    // Mutate one sibling, delete the other, after the review exists.
    store.items.set(
      'mem-r1',
      itemRow({ id: 'mem-r1', kind: 'fact', key: 'fact:k', value: 'CHANGED' }),
    );
    store.items.delete('mem-r2');

    const detail = await getMemoryReviewDetail({ db, subject, reviewId });
    const snap = detail!.reviewSnapshot!;
    const retiring = snap.retiring!;
    expect(retiring.map((r) => r.value).sort()).toEqual(['dup one', 'dup two']);
    expect(snap.conflict!.active.value).toBe('canonical target');
    // Target keeps its own citations; merge-level evidence is captured too.
    expect(snap.conflict!.active.evidenceIds).toEqual(['mev-t']);
    expect(snap.evidence.map((e) => e.id).sort()).toEqual(['mev-1', 'mev-t']);
  });

  it('fails closed when the merge target cannot be captured (concurrent delete)', async () => {
    const store = emptyStore();
    store.items.set(
      'mem-t',
      itemRow({ id: 'mem-t', kind: 'fact', key: 'fact:k', value: 'target' }),
    );
    store.items.set(
      'mem-r1',
      itemRow({ id: 'mem-r1', kind: 'fact', key: 'fact:k', value: 'dup' }),
    );
    store.evidence.set(
      'mev-1',
      evidenceRow({ id: 'mev-1', text: 'merge grounding' }),
    );
    // Validation sees mem-t (inArray), but its single-id capture read returns
    // nothing — as if it were deleted between the two DB reads.
    const outcome = await createPendingMemoryReview({
      db: makeDb(store, { vanishOnCapture: 'mem-t' }),
      runId: 'run-mt',
      subject,
      phase: 'deep',
      proposal: {
        action: 'merge',
        targetItemId: 'mem-t',
        itemIds: ['mem-t', 'mem-r1'],
        reason: 'duplicates',
        confidence: 0.9,
        evidenceIds: ['mev-1'],
      },
    });
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('merge target');
    expect(store.reviews).toHaveLength(0);
  });

  it('parser rejects a schema-v1 snapshot citing evidence absent from evidence[]', async () => {
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
    // conflict.active cites mev-missing, but evidence[] only has mev-present.
    const snapshot: MemoryReviewSnapshot = {
      schemaVersion: 1,
      subject: {
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      },
      conflict: {
        active: {
          itemId: 'mem-9',
          kind: 'fact',
          key: 'fact:y',
          value: 'frozen',
          evidenceIds: ['mev-missing'],
        },
      },
      evidence: [
        {
          id: 'mev-present',
          role: 'active',
          sourceType: 'session',
          text: 'present',
          capturedAt: '2026-05-07T00:00:00.000Z',
        },
      ],
    };
    store.reviews.push(
      reviewRow({
        id: 'mrv_incomplete',
        proposal: {
          action: 'needs_review',
          itemId: 'mem-9',
          value: 'proposed value',
          reason: 'r',
          confidence: 0.9,
          evidenceIds: [],
        },
        snapshot,
      }),
    );
    const [review] = await listPendingMemoryReviews({
      db: makeDb(store),
      subject,
    });
    expect(review.reviewSnapshot).toBeNull();
    expect(review.proposedChange!.before!.value).toBe('current live value');
  });

  it('renders EACH review from its own snapshot: two reviews of the same item keep distinct frozen before-values', async () => {
    const store = emptyStore();
    // Live item drifted to a value neither snapshot froze.
    store.items.set(
      'mem-1',
      itemRow({
        id: 'mem-1',
        kind: 'fact',
        key: 'fact:k',
        value: 'live-current',
      }),
    );
    store.reviews.push(
      reviewRow({
        id: 'mrv_a',
        proposal: {
          action: 'needs_review',
          itemId: 'mem-1',
          value: 'after-A',
          reason: 'r',
          confidence: 0.9,
          evidenceIds: ['mev-a'],
        },
        snapshot: validSnapshot({
          activeItemId: 'mem-1',
          activeValue: 'frozen-A',
          afterValue: 'after-A',
          evidenceId: 'mev-a',
          evidenceText: 'text-A',
        }),
      }),
    );
    store.reviews.push(
      reviewRow({
        id: 'mrv_b',
        proposal: {
          action: 'needs_review',
          itemId: 'mem-1',
          value: 'after-B',
          reason: 'r',
          confidence: 0.9,
          evidenceIds: ['mev-b'],
        },
        snapshot: validSnapshot({
          activeItemId: 'mem-1',
          activeValue: 'frozen-B',
          afterValue: 'after-B',
          evidenceId: 'mev-b',
          evidenceText: 'text-B',
        }),
      }),
    );
    const reviews = await listPendingMemoryReviews({
      db: makeDb(store),
      subject,
    });
    const a = reviews.find((r) => r.id === 'mrv_a')!;
    const b = reviews.find((r) => r.id === 'mrv_b')!;
    expect(a.proposedChange!.before!.value).toBe('frozen-A');
    expect(b.proposedChange!.before!.value).toBe('frozen-B');
    expect(a.proposedChange!.before!.value).not.toBe(
      b.proposedChange!.before!.value,
    );
  });

  it('renders EACH review from its own snapshot: same evidence id, distinct frozen text/timestamp per review', async () => {
    const store = emptyStore();
    store.reviews.push(
      reviewRow({
        id: 'mrv_a',
        proposal: {
          action: 'needs_review',
          itemId: 'mem-1',
          value: 'after-A',
          reason: 'r',
          confidence: 0.9,
          evidenceIds: ['mev-shared'],
        },
        snapshot: validSnapshot({
          activeItemId: 'mem-1',
          activeValue: 'a',
          afterValue: 'after-A',
          evidenceId: 'mev-shared',
          evidenceText: 'evidence text BEFORE edit',
          capturedAt: '2026-01-01T00:00:00.000Z',
        }),
      }),
    );
    store.reviews.push(
      reviewRow({
        id: 'mrv_b',
        proposal: {
          action: 'needs_review',
          itemId: 'mem-2',
          value: 'after-B',
          reason: 'r',
          confidence: 0.9,
          evidenceIds: ['mev-shared'],
        },
        snapshot: validSnapshot({
          activeItemId: 'mem-2',
          activeValue: 'b',
          afterValue: 'after-B',
          evidenceId: 'mev-shared',
          evidenceText: 'evidence text AFTER edit',
          capturedAt: '2026-02-02T00:00:00.000Z',
        }),
      }),
    );
    const page = await listPendingMemoryReviewPage({
      db: makeDb(store),
      subject,
    });
    const items = page.reviewPage!.items;
    const a = items.find((i) => i.reviewId === 'mrv_a')!;
    const b = items.find((i) => i.reviewId === 'mrv_b')!;
    expect(a.evidence[0].snippet).toBe('evidence text BEFORE edit');
    expect(a.evidence[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(b.evidence[0].snippet).toBe('evidence text AFTER edit');
    expect(b.evidence[0].createdAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('incomplete schema-v1 snapshot falls back to legacy re-query render', async () => {
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
      ...reviewRow({
        id: 'mrv_legacy',
        proposal: {
          action: 'needs_review',
          itemId: 'mem-9',
          value: 'proposed value',
          reason: 'r',
          confidence: 0.9,
          evidenceIds: [],
        },
        snapshot: null,
      }),
      // schemaVersion 1 but subject lacks identifiers and active lacks fields.
      reviewSnapshotJson:
        '{"schemaVersion":1,"subject":{},"evidence":[],"conflict":{"active":{}}}',
    });
    const [review] = await listPendingMemoryReviews({
      db: makeDb(store),
      subject,
    });
    expect(review.reviewSnapshot).toBeNull();
    expect(review.proposedChange!.before!.value).toBe('current live value');
  });
});

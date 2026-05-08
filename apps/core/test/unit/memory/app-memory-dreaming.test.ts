import { describe, expect, it, vi } from 'vitest';

import { runAppMemoryDreamPass } from '@core/memory/app-memory-dreaming.js';
import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';

const subject: NormalizedMemorySubject = {
  appId: 'app-a',
  agentId: 'agent-a',
  groupId: 'group-a',
  subjectType: 'group',
  subjectId: 'group-a',
};

function collectSqlParamValues(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as { constructor?: { name?: string }; value?: unknown };
  if (record.constructor?.name === 'Param') return [record.value];
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) ? chunks.flatMap(collectSqlParamValues) : [];
}

function evidenceRow(
  input: {
    id?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  } = {},
) {
  return {
    id: input.id ?? 'mev-1',
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    userId: null,
    groupId: subject.groupId ?? null,
    channelId: null,
    threadId: null,
    sourceType: 'session',
    sourceId: 'session-1',
    actorId: 'user-1',
    text:
      input.text ??
      'Raw transcript evidence that must never be copied directly into memory.',
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: '2026-05-07T00:00:00.000Z',
  };
}

function candidateRow(
  input: {
    id?: string;
    kind?: string;
    key?: string;
    value?: string;
    reason?: string | null;
    confidence?: number;
    evidenceIdsJson?: string;
    metadataJson?: string;
  } = {},
) {
  return {
    id: input.id ?? 'mca-1',
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    threadId: null,
    kind: input.kind ?? 'decision',
    key: input.key ?? 'decision:queue-policy',
    value: input.value ?? 'Runtime queue policy belongs under runtime.queue.',
    reason: input.reason ?? 'Queue policy belongs under runtime.queue.',
    metadataJson: input.metadataJson ?? '{}',
    evidenceIdsJson: input.evidenceIdsJson ?? '["mev-1"]',
    confidence: input.confidence ?? 0.91,
    status: 'staged',
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
  };
}

function activeItemRow(
  input: {
    id?: string;
    key?: string;
    kind?: string;
    value?: string;
  } = {},
) {
  return {
    id: input.id ?? 'mem-1',
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    userId: null,
    conversationId: null,
    threadId: null,
    kind: input.kind ?? 'decision',
    key: input.key ?? 'decision:queue-policy',
    valueJson: JSON.stringify({ value: input.value ?? 'old value', why: null }),
    sourceRefJson: '{}',
    confidence: 0.8,
    status: 'active',
    lastObservedAt: null,
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
  };
}

function createDb(selectResponses: unknown[][]) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const whereConditions: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        whereConditions.push(condition);
        return {
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => selectResponses.shift() ?? []),
          })),
        };
      }),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      inserted.push(value);
      return {
        onConflictDoNothing: vi.fn(async () => undefined),
        returning: vi.fn(async () => [value]),
      };
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => {
      updated.push(value);
      return {
        where: vi.fn(async () => undefined),
        returning: vi.fn(async () => []),
      };
    }),
  }));

  return {
    db: { select, insert, update },
    inserted,
    updated,
    whereConditions,
  };
}

function stagedCandidateValues(inserted: unknown[]) {
  return inserted.filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).status === 'staged',
  );
}

function decisionValues(inserted: unknown[]) {
  return inserted.filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).action === 'string',
  );
}

describe('runAppMemoryDreamPass guardrails', () => {
  it('filters evidence and staged candidates by exact thread scope when provided', async () => {
    const threadedSubject: NormalizedMemorySubject = {
      ...subject,
      threadId: 'thread-1',
    };
    const { db, whereConditions } = createDb([
      [evidenceRow()],
      [candidateRow()],
    ]);

    await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-threaded',
      subject: threadedSubject,
      phase: 'all',
      dryRun: true,
      listItems: vi.fn(async () => []),
      save: vi.fn(),
      retire: vi.fn(async () => ({ deleted: true })),
    });

    const params = whereConditions.flatMap((condition) =>
      collectSqlParamValues(condition),
    );
    expect(params).toContain('thread-1');
  });

  it('does not stage raw evidence text during light dreaming', async () => {
    const { db, inserted } = createDb([
      [evidenceRow({ text: 'Ravi prefers raw transcript snippets.' })],
    ]);
    const listItems = vi.fn();

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-raw',
      subject,
      phase: 'light',
      dryRun: false,
      listItems,
      save: vi.fn(),
      retire: vi.fn(async () => ({ deleted: true })),
    });

    expect(decisions).toEqual([{ action: 'skip' }]);
    expect(listItems).not.toHaveBeenCalled();
    expect(stagedCandidateValues(inserted)).toHaveLength(0);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'skip',
        evidenceIdsJson: '["mev-1"]',
        applied: false,
      },
    ]);
  });

  it('stages only structured canonical evidence candidates', async () => {
    const text =
      'Raw transcript text should remain evidence and not become candidate value.';
    const { db, inserted } = createDb([
      [
        evidenceRow({
          text,
          metadata: {
            memoryCandidate: {
              kind: 'decision',
              scope: 'group',
              key: 'decision:queue-policy',
              value: 'Runtime queue policy belongs under runtime.queue.',
              why: 'Queue policy belongs under runtime.queue.',
              confidence: 0.91,
              safety: 'safe',
            },
          },
        }),
      ],
    ]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-structured',
      subject,
      phase: 'light',
      dryRun: false,
      listItems: vi.fn(),
      save: vi.fn(),
      retire: vi.fn(async () => ({ deleted: true })),
    });

    expect(decisions).toEqual([{ action: 'stage_candidate' }]);
    expect(stagedCandidateValues(inserted)).toMatchObject([
      {
        kind: 'decision',
        key: 'decision:queue-policy',
        value: 'Runtime queue policy belongs under runtime.queue.',
        reason: 'Queue policy belongs under runtime.queue.',
        confidence: 0.91,
        evidenceIdsJson: '["mev-1"]',
      },
    ]);
    expect(stagedCandidateValues(inserted)[0]?.value).not.toBe(text);
  });

  it('does not insert candidates or apply decisions during light dry runs', async () => {
    const { db, inserted } = createDb([
      [
        evidenceRow({
          metadata: {
            memoryCandidate: {
              kind: 'decision',
              scope: 'group',
              key: 'decision:queue-policy',
              value: 'Runtime queue policy belongs under runtime.queue.',
              why: 'Queue policy belongs under runtime.queue.',
              confidence: 0.91,
              safety: 'safe',
            },
          },
        }),
      ],
    ]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-light-dry',
      subject,
      phase: 'light',
      dryRun: true,
      listItems: vi.fn(),
      save: vi.fn(),
      retire: vi.fn(async () => ({ deleted: true })),
    });

    expect(decisions).toEqual([{ action: 'stage_candidate' }]);
    expect(stagedCandidateValues(inserted)).toHaveLength(0);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'stage_candidate',
        candidateId: expect.stringMatching(/^mca_/),
        evidenceIdsJson: '["mev-1"]',
        applied: false,
      },
    ]);
  });

  it('blocks old raw-evidence candidates during deep dreaming', async () => {
    const rawCandidate = candidateRow({
      id: 'mca-raw',
      kind: 'fact',
      key: 'evidence:deadbeef12345678',
      value: 'Raw evidence copied directly from the transcript.',
      reason: 'Recent grounded evidence is available for memory review.',
      confidence: 0.55,
      evidenceIdsJson: '["mev-raw"]',
    });
    const save = vi.fn();
    const { db, inserted, updated } = createDb([[], [rawCandidate]]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-deep-raw',
      subject,
      phase: 'deep',
      dryRun: false,
      listItems: vi.fn(async () => []),
      save,
      retire: vi.fn(async () => ({ deleted: true })),
    });

    expect(decisions).toEqual([{ action: 'blocked' }]);
    expect(save).not.toHaveBeenCalled();
    expect(updated).toMatchObject([{ status: 'needs_review' }]);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'blocked',
        candidateId: 'mca-raw',
        evidenceIdsJson: '["mev-raw"]',
        applied: false,
      },
    ]);
  });

  it('does not save or update candidates during deep dry runs', async () => {
    const save = vi.fn();
    const retire = vi.fn(async () => ({ deleted: true }));
    const { db, inserted, updated } = createDb([[], [candidateRow()]]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-deep-dry',
      subject,
      phase: 'deep',
      dryRun: true,
      listItems: vi.fn(async () => []),
      save,
      retire,
    });

    expect(decisions).toEqual([{ action: 'dry_run' }]);
    expect(save).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(updated).toHaveLength(0);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'dry_run',
        candidateId: 'mca-1',
        evidenceIdsJson: '["mev-1"]',
        applied: false,
      },
    ]);
  });

  it('promotes validated staged candidates during deep dreaming', async () => {
    const save = vi.fn(async () => ({ id: 'mem-1' }));
    const listItems = vi.fn(async () => []);
    const retire = vi.fn(async () => ({ deleted: true }));
    const { db, inserted, updated } = createDb([[], [candidateRow()]]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-deep-valid',
      subject,
      phase: 'deep',
      dryRun: false,
      listItems,
      save,
      retire,
    });

    expect(decisions).toEqual([{ action: 'promote' }]);
    expect(listItems).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'decision',
        key: 'decision:queue-policy',
        value: 'Runtime queue policy belongs under runtime.queue.',
        why: 'Queue policy belongs under runtime.queue.',
        confidence: 0.91,
        source: 'dreaming',
        evidenceIds: ['mev-1'],
      }),
    );
    expect(updated).toMatchObject([{ status: 'promoted' }]);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'promote',
        itemId: 'mem-1',
        candidateId: 'mca-1',
        evidenceIdsJson: '["mev-1"]',
        applied: true,
      },
    ]);
  });

  it('updates an existing memory item when staged value changes', async () => {
    const save = vi.fn(async () => ({ id: 'mem-1' }));
    const { db, inserted, updated } = createDb([
      [],
      [candidateRow({ value: 'new value' })],
    ]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-deep-update',
      subject,
      phase: 'deep',
      dryRun: false,
      listItems: vi.fn(async () => [
        { row: activeItemRow({ value: 'old value' }) },
      ]),
      save,
      retire: vi.fn(async () => ({ deleted: true })),
    });

    expect(decisions).toEqual([{ action: 'update' }]);
    expect(updated).toMatchObject([{ status: 'updated' }]);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'update',
        candidateId: 'mca-1',
        itemId: 'mem-1',
        applied: true,
      },
    ]);
  });

  it('routes staged retire candidates to memory review', async () => {
    const retire = vi.fn(async () => ({ deleted: true }));
    const createPendingReview = vi.fn(async () => 'mrv-retire');
    const candidate = candidateRow({
      metadataJson: JSON.stringify({
        operation: 'retire',
        retire_key: 'decision:queue-policy',
      }),
    });
    const { db, inserted, updated } = createDb([[], [candidate]]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-deep-retire',
      subject,
      phase: 'deep',
      dryRun: false,
      listItems: vi.fn(async () => [
        { row: activeItemRow({ id: 'mem-retire' }) },
      ]),
      save: vi.fn(),
      retire,
      createPendingReview,
    });

    expect(decisions).toEqual([{ action: 'needs_review' }]);
    expect(retire).not.toHaveBeenCalled();
    expect(createPendingReview).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'retire',
        itemId: 'mem-retire',
        candidateId: 'mca-1',
        evidenceIds: ['mev-1'],
      }),
    );
    expect(updated).toMatchObject([{ status: 'needs_review' }]);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'needs_review',
        candidateId: 'mca-1',
        itemId: 'mem-retire',
        applied: false,
      },
    ]);
  });

  it('records blocked decision when dream embedding persistence is retryable', async () => {
    const { db, inserted } = createDb([[], [candidateRow()]]);

    const decisions = await runAppMemoryDreamPass({
      db: db as never,
      runId: 'mdr-embed-retry',
      subject,
      phase: 'deep',
      dryRun: false,
      listItems: vi.fn(async () => []),
      save: vi.fn(async () => ({ id: 'mem-embed' })),
      retire: vi.fn(async () => ({ deleted: true })),
      storeDreamEmbedding: vi.fn(async () => ({
        status: 'retryable',
        reason: 'temporary embedding outage',
      })),
    });

    expect(decisions).toEqual([{ action: 'promote' }, { action: 'blocked' }]);
    expect(decisionValues(inserted)).toMatchObject([
      {
        action: 'promote',
        candidateId: 'mca-1',
        itemId: 'mem-embed',
        applied: true,
      },
      {
        action: 'blocked',
        candidateId: 'mca-1',
        itemId: 'mem-embed',
        applied: false,
      },
    ]);
  });
});

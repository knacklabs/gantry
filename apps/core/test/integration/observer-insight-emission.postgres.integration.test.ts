import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import {
  _setRuntimeStorageForTest,
  closeRuntimeStorage,
} from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import {
  runBrainDreamBatch,
  type BrainDreamProposal,
} from '@core/brain/brain-dreaming.js';
import {
  OBSERVER_CURSOR_SUBJECT,
  type ObserverInsightEmissionRuntime,
} from '@core/brain/observer-insight-emission.js';
import { BrainService } from '@core/brain/brain-service.js';
import { listObserverActiveMemoryValues } from '@core/memory/app-memory-item-queries.js';
import { CachedEmbeddingProvider } from '@core/memory/memory-embedding-cache.js';
import { PostgresEmbeddingCacheStore } from '@core/memory/memory-embedding-cache-store.js';
import type { EmbeddingProvider } from '@core/memory/memory-embeddings.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const DIMENSIONS = 1536;
const MODEL = 'observer-test';
const EMPTY_CANDIDATES_APP_ID = 'observer-empty-candidates-app';
const ARRAY_PROPOSAL_APP_ID = 'observer-array-proposal-app';

maybeDescribe('observer insight emission postgres integration', () => {
  let runtime: PostgresIntegrationRuntime;
  let repository: PostgresBrainRepository;
  let brain: BrainService;
  let embedding: EmbeddingProvider;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_emission',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    repository = new PostgresBrainRepository(runtime.service.db);
    brain = new BrainService(repository);
    runtimeForHelpers = runtime;
    brainForHelpers = brain;
    embedding = new CachedEmbeddingProvider(
      fakeEmbeddingProvider,
      new PostgresEmbeddingCacheStore(runtime.service.db),
      MODEL,
      DIMENSIONS,
    );
    for (const appId of [EMPTY_CANDIDATES_APP_ID, ARRAY_PROPOSAL_APP_ID]) {
      await runtime.repositories.apps.saveApp({
        id: appId as never,
        slug: appId,
        name: appId,
        status: 'active',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      });
    }
    await runtime.service.db.insert(pgSchema.patternCandidatesPostgres).values({
      id: 'pattern-repeated-export',
      appId: 'default',
      agentId: 'agent-1',
      folder: 'main',
      subjectType: 'channel',
      subjectId: 'conversation:slack:C123',
      signature: 'pattern-export',
      outcomeLabel: 'export weekly reports',
      shortAsk: 'Create a reusable report export.',
      occurrences: 4,
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-07-04T00:00:00.000Z',
      lastDetectedAt: '2026-07-04T00:00:00.000Z',
      candidateStatus: 'detected',
      proposalStatus: null,
      snoozedUntil: null,
      evidenceRefsJson: [
        { kind: 'transcript', id: 'transcript-1' },
        { kind: 'transcript', id: 'transcript-2' },
      ],
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
  }, 60_000);

  afterAll(async () => {
    await closeRuntimeStorage().catch(() => undefined);
    await runtime.cleanup();
  });

  it('applies floors and semantic dedup, persists structured evidence, and keeps unavailable retries cursor-safe', async () => {
    const first = await writeChannelPage(
      'observer-first',
      '2026-07-22T01:00:00.000Z',
    );
    const firstResult = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: proposerFor('first'),
      observer: observerRuntime(embedding),
    });

    expect(firstResult).toMatchObject({
      pages: 1,
      observer: { persisted: 2, deduplicated: 0, filtered: 2 },
    });
    const subject = 'conversation:slack:C123' as const;
    const firstRows = await runtime.repositories.observerInsights.list({
      appId: 'default',
      subject,
      limit: 20,
    });
    expect(firstRows).toHaveLength(2);
    expect(firstRows.map((row) => row.insightType).sort()).toEqual([
      'commitment',
      'repetition',
    ]);
    expect(
      firstRows.find((row) => row.insightType === 'commitment')?.evidenceRefs,
    ).toEqual([
      {
        conversationId: subject,
        messageId: first.id,
        ts: first.updatedAt,
      },
    ]);
    expect(
      firstRows.find((row) => row.insightType === 'repetition')?.evidenceRefs,
    ).toEqual([
      {
        conversationId: subject,
        messageId: 'transcript-1',
        ts: '2026-07-04T00:00:00.000Z',
      },
      {
        conversationId: subject,
        messageId: 'transcript-2',
        ts: '2026-07-04T00:00:00.000Z',
      },
    ]);
    expect(
      await runtime.repositories.observerInsights.getInsightCursor(
        'default',
        OBSERVER_CURSOR_SUBJECT,
      ),
    ).toMatchObject({ pageId: first.id });

    await writeChannelPage('observer-second', '2026-07-22T02:00:00.000Z');
    const secondResult = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: proposerFor('second'),
      observer: observerRuntime(embedding),
    });
    expect(secondResult.observer).toMatchObject({
      persisted: 0,
      deduplicated: 1,
    });
    expect(
      await runtime.repositories.observerInsights.count({
        appId: 'default',
      }),
    ).toBe(2);
    const originalCommitment = firstRows.find(
      (row) => row.insightType === 'commitment',
    )!;
    await runtime.repositories.observerInsights.transitionState({
      id: originalCommitment.id,
      from: 'pending',
      to: 'dropped',
      nowIso: '2026-07-22T02:30:00.000Z',
    });
    const recurrence = await writeChannelPage(
      'observer-recurrence',
      '2026-07-22T03:00:00.000Z',
    );
    const recurrenceResult = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: proposerFor('recurrence'),
      observer: observerRuntime(embedding),
    });
    expect(recurrenceResult.observer).toMatchObject({
      persisted: 1,
      deduplicated: 0,
    });
    const recurringCommitment =
      await runtime.repositories.observerInsights.findBySignature({
        appId: 'default',
        subject,
        canonicalSignature: originalCommitment.canonicalSignature,
      });
    expect(recurringCommitment?.id).not.toBe(originalCommitment.id);
    expect(recurringCommitment?.state).toBe('pending');

    const originalRepetition = firstRows.find(
      (row) => row.insightType === 'repetition',
    )!;
    await runtime.repositories.observerInsights.transitionState({
      id: originalRepetition.id,
      from: 'pending',
      to: 'dropped',
      nowIso: '2026-07-22T03:10:00.000Z',
    });
    const noUnexpectedPageCall = {
      propose: async (): Promise<BrainDreamProposal> => {
        throw new Error('no page proposal expected');
      },
    };
    const stableRepetitionResult = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: noUnexpectedPageCall,
      observer: observerRuntime(embedding),
    });
    expect(stableRepetitionResult).toMatchObject({
      pages: 0,
      observer: { persisted: 0, deduplicated: 0 },
    });

    await runtime.service.db
      .update(pgSchema.patternCandidatesPostgres)
      .set({
        occurrences: 5,
        lastDetectedAt: '2026-07-05T00:00:00.000Z',
        evidenceRefsJson: [
          { kind: 'transcript', id: 'transcript-1' },
          { kind: 'transcript', id: 'transcript-2' },
          { kind: 'transcript', id: 'transcript-3' },
        ],
        updatedAt: '2026-07-05T00:00:00.000Z',
      })
      .where(
        eq(pgSchema.patternCandidatesPostgres.id, 'pattern-repeated-export'),
      );
    const changedRepetitionResult = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: noUnexpectedPageCall,
      observer: observerRuntime(embedding),
    });
    expect(changedRepetitionResult).toMatchObject({
      pages: 0,
      observer: { persisted: 1, deduplicated: 0 },
    });
    const repetitionRows = await runtime.repositories.observerInsights.list({
      appId: 'default',
      subject,
      insightType: 'repetition',
      limit: 20,
    });
    expect(repetitionRows).toHaveLength(2);
    expect(repetitionRows.map((row) => row.state).sort()).toEqual([
      'dropped',
      'pending',
    ]);
    const changedRepetition = repetitionRows.find(
      (row) => row.state === 'pending',
    )!;
    expect(changedRepetition.id).not.toBe(originalRepetition.id);
    expect(changedRepetition.evidenceRefs).toContainEqual({
      conversationId: subject,
      messageId: 'transcript-3',
      ts: '2026-07-05T00:00:00.000Z',
    });

    const observerCursorBeforeUnavailable =
      await runtime.repositories.observerInsights.getInsightCursor(
        'default',
        OBSERVER_CURSOR_SUBJECT,
      );
    expect(observerCursorBeforeUnavailable).toMatchObject({
      pageId: recurrence.id,
    });

    const unavailablePage = await writeChannelPage(
      'observer-unavailable',
      '2026-07-22T04:00:00.000Z',
    );
    const unavailableResult = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: proposerFor('unavailable'),
      observer: observerRuntime(undefined),
    });
    expect(unavailableResult).toMatchObject({
      pages: 1,
      applied: 1,
      observer: {
        persisted: 0,
        message: 'Insight emission paused: embeddings unavailable.',
      },
    });
    expect(
      await runtime.repositories.observerInsights.count({
        appId: 'default',
      }),
    ).toBe(4);
    expect(
      await runtime.repositories.observerInsights.getInsightCursor(
        'default',
        OBSERVER_CURSOR_SUBJECT,
      ),
    ).toEqual(observerCursorBeforeUnavailable);
    expect(await repository.getDreamCursor('default')).toMatchObject({
      pageId: unavailablePage.id,
    });

    const observerOnlyRetry = await runBrainDreamBatch({
      brain,
      repository,
      appId: 'default',
      proposer: proposerFor('unavailable'),
      observer: observerRuntime(embedding),
    });
    expect(observerOnlyRetry).toMatchObject({
      pages: 1,
      applied: 0,
      observer: { persisted: 0, deduplicated: 1 },
    });
    expect(
      await runtime.repositories.observerInsights.getInsightCursor(
        'default',
        OBSERVER_CURSOR_SUBJECT,
      ),
    ).toMatchObject({ pageId: unavailablePage.id });
    expect(
      await runtime.repositories.observerInsights.count({ appId: 'default' }),
    ).toBe(4);
  });

  it('keeps empty-candidate runs paused until embeddings are available, then advances without embedding', async () => {
    const page = await writeChannelPage(
      'observer-empty-candidates',
      '2026-07-22T05:00:00.000Z',
      EMPTY_CANDIDATES_APP_ID,
    );
    let embedManyCalls = 0;
    const shouldNotEmbed: EmbeddingProvider = {
      isEnabled: () => true,
      validateConfiguration: () => undefined,
      expectedDimensions: () => DIMENSIONS,
      embedMany: async () => {
        embedManyCalls += 1;
        throw new Error('empty candidates must not invoke embeddings');
      },
      embedOne: async () => {
        throw new Error('empty candidates must not invoke embeddings');
      },
    };
    const emptyProposal = {
      propose: async (): Promise<BrainDreamProposal> => ({
        operations: [],
        surfaceableInsights: [insight('commitment', '!!!', 0.95, [page.id])],
      }),
    };

    const paused = await runBrainDreamBatch({
      brain,
      repository,
      appId: EMPTY_CANDIDATES_APP_ID,
      proposer: emptyProposal,
      observer: observerRuntime(undefined),
    });
    expect(paused).toMatchObject({
      pages: 1,
      observer: {
        persisted: 0,
        message: 'Insight emission paused: embeddings unavailable.',
      },
    });
    await expect(
      runtime.repositories.observerInsights.getInsightCursor(
        EMPTY_CANDIDATES_APP_ID,
        OBSERVER_CURSOR_SUBJECT,
      ),
    ).resolves.toBeNull();

    const result = await runBrainDreamBatch({
      brain,
      repository,
      appId: EMPTY_CANDIDATES_APP_ID,
      proposer: emptyProposal,
      observer: observerRuntime(shouldNotEmbed),
    });

    expect(result).toMatchObject({
      pages: 1,
      observer: {
        persisted: 0,
        deduplicated: 0,
        filtered: 0,
        message:
          'Insight emission complete: 0 persisted, 0 deduplicated, 0 filtered.',
      },
    });
    expect(embedManyCalls).toBe(0);
    expect(
      await runtime.repositories.observerInsights.getInsightCursor(
        EMPTY_CANDIDATES_APP_ID,
        OBSERVER_CURSOR_SUBJECT,
      ),
    ).toMatchObject({ pageId: page.id });
  });

  it('rejects an injected legacy array proposal without advancing the observer cursor', async () => {
    await writeChannelPage(
      'observer-array-proposal',
      '2026-07-22T06:00:00.000Z',
      ARRAY_PROPOSAL_APP_ID,
    );

    await expect(
      runBrainDreamBatch({
        brain,
        repository,
        appId: ARRAY_PROPOSAL_APP_ID,
        proposer: { propose: async () => [] },
        observer: observerRuntime(embedding),
      }),
    ).rejects.toThrow(
      'Brain dreaming observer proposal requires operations and surfaceableInsights arrays',
    );
    await expect(
      runtime.repositories.observerInsights.getInsightCursor(
        ARRAY_PROPOSAL_APP_ID,
        OBSERVER_CURSOR_SUBJECT,
      ),
    ).resolves.toBeNull();
  });
});

function observerRuntime(
  provider: EmbeddingProvider | undefined,
): ObserverInsightEmissionRuntime & { enabled: true } {
  return {
    enabled: true,
    ownerRecipient: 'owner-1',
    cursorSubject: OBSERVER_CURSOR_SUBJECT,
    repository: runtimeForHelpers.repositories.observerInsights,
    patterns: runtimeForHelpers.repositories.patternCandidates,
    activeMemory: {
      listActiveValues: (input) =>
        listObserverActiveMemoryValues({
          db: runtimeForHelpers.service.db,
          ...input,
        }),
    },
    embedding: provider,
    embeddingModel: MODEL,
    embeddingDimensions: DIMENSIONS,
  };
}

function proposerFor(mode: 'first' | 'second' | 'recurrence' | 'unavailable'): {
  propose: (input: {
    pages: Array<{ id: string }>;
  }) => Promise<BrainDreamProposal>;
} {
  return {
    propose: async ({ pages }) => {
      const evidencePageId = pages[0]!.id;
      if (mode === 'unavailable') {
        return {
          operations: [
            { action: 'upsert_entity', kind: 'topic', name: 'Observer retry' },
          ],
          surfaceableInsights: [
            insight('commitment', 'ship beta friday', 0.95, [evidencePageId]),
          ],
        };
      }
      if (mode === 'second') {
        return {
          operations: [],
          surfaceableInsights: [
            insight('commitment', 'beta will ship this friday', 0.95, [
              evidencePageId,
            ]),
          ],
        };
      }
      if (mode === 'recurrence') {
        return {
          operations: [],
          surfaceableInsights: [
            insight('commitment', 'ship beta friday', 0.95, [evidencePageId]),
          ],
        };
      }
      return {
        operations: [],
        surfaceableInsights: [
          insight('commitment', 'ship beta friday', 0.95, [evidencePageId]),
          insight('open_question', 'low confidence question', 0.59, [
            evidencePageId,
          ]),
          insight('stale_fact', 'missing evidence', 0.95, ['not-this-page']),
        ],
      };
    },
  };
}

function insight(
  insightType:
    | 'commitment'
    | 'contradiction'
    | 'open_question'
    | 'stale_fact'
    | 'decision_without_owner'
    | 'duplicated_work',
  canonicalSignature: string,
  confidence: number,
  evidencePageIds: string[],
) {
  return {
    insightType,
    title: canonicalSignature,
    summary: canonicalSignature,
    canonicalSignature,
    confidence,
    evidencePageIds,
  };
}

async function writeChannelPage(
  slug: string,
  updatedAt: string,
  appId = 'default',
) {
  const written = await brainForHelpers.write({
    appId,
    slug,
    markdown: `# ${slug}\nThe team discussed beta.`,
    sourceKind: 'channel',
    sourceRef: 'slack-one:slack:C123#2026-07-22',
    embed: false,
  });
  await runtimeForHelpers.service.db
    .update(pgSchema.brainPagesPostgres)
    .set({ updatedAt })
    .where(eq(pgSchema.brainPagesPostgres.id, written.page.id));
  return (await brainForHelpers.getPageBySlug(appId, slug))!;
}

const fakeEmbeddingProvider: EmbeddingProvider = {
  isEnabled: () => true,
  validateConfiguration: () => undefined,
  expectedDimensions: () => DIMENSIONS,
  embedMany: async (texts) => texts.map(vectorFor),
  embedOne: async (text) => vectorFor(text),
};

function vectorFor(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[
    text.includes('export weekly reports')
      ? 1
      : text.includes('low confidence')
        ? 2
        : text.includes('missing evidence')
          ? 3
          : 0
  ] = 1;
  return vector;
}

let runtimeForHelpers: PostgresIntegrationRuntime;
let brainForHelpers: BrainService;

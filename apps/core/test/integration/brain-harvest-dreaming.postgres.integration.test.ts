import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import {
  _setRuntimeStorageForTest,
  closeRuntimeStorage,
} from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { BrainChannelHarvester } from '@core/brain/brain-channel-harvest.js';
import {
  applyBrainDreamOperations,
  runBrainDreamBatch,
} from '@core/brain/brain-dreaming.js';
import { runBrainEmbeddingBackfill } from '@core/brain/brain-embedding-backfill.js';
import { BrainService } from '@core/brain/brain-service.js';
import type { NewMessage } from '@core/domain/types.js';
import type { EmbeddingProvider } from '@core/memory/memory-embeddings.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const DIMENSIONS = 1536;
const embeddingConfig = {
  provider: 'test',
  model: 'fake',
  dimensions: DIMENSIONS,
};

const fakeProvider: EmbeddingProvider = {
  isEnabled: () => true,
  validateConfiguration: () => undefined,
  expectedDimensions: () => DIMENSIONS,
  embedMany: async (texts) => texts.map(vectorFor),
  embedOne: async (text) => vectorFor(text),
};

maybeDescribe('brain harvest and dreaming postgres integration', () => {
  let runtime: PostgresIntegrationRuntime;
  let repo: PostgresBrainRepository;
  let brain: BrainService;
  let harvester: BrainChannelHarvester;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'brain_harvest_dream',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    repo = new PostgresBrainRepository(runtime.service.db);
    brain = new BrainService(repo);
    harvester = new BrainChannelHarvester(brain);
    runtimeForHelpers = runtime;
    brainForHelpers = brain;
  }, 60_000);

  afterAll(async () => {
    await closeRuntimeStorage().catch(() => undefined);
    await runtime.cleanup();
  });

  it('harvests opted-in channel pages and dreams grounded additive facts', async () => {
    await harvester.harvest({
      appId: 'default',
      message: channelMessage({ id: 'skip-1' }),
      settings: settingsWithHarvest(false),
    });
    expect(await brain.status('default')).toMatchObject({
      pages: 0,
      entities: 0,
      edges: 0,
    });

    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        id: 'm1',
        content: 'Alice works at Acme.',
        timestamp: '2026-07-07T01:00:00.000Z',
      }),
      settings: settingsWithHarvest(true),
    });
    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        id: 'm1-duplicate',
        content: 'Alice works at Acme.',
        timestamp: '2026-07-07T01:00:00.000Z',
      }),
      settings: settingsWithHarvest(true),
    });
    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        id: 'm2',
        content: 'Bob joined the Acme thread.',
        sender: 'U2',
        sender_name: 'Bob',
        timestamp: '2026-07-07T01:02:00.000Z',
      }),
      settings: settingsWithHarvest(true),
    });

    const channelPage = await brain.getPageBySlug(
      'default',
      'chan-slack-one-sl-c123-t1-1493bf64d4',
    );
    expect(channelPage).toMatchObject({
      slug: 'chan-slack-one-sl-c123-t1-1493bf64d4',
      sourceKind: 'channel',
    });
    expect(channelPage?.markdown.match(/Alice works at Acme/g)).toHaveLength(1);
    expect(channelPage?.markdown).toContain(
      '[Bob at 2026-07-07T01:02:00.000Z]',
    );
    expect(channelPage?.metadata.people).toEqual(['Alice', 'Bob']);

    const embedded = new BrainService(repo, {
      embedding: { config: embeddingConfig, provider: fakeProvider },
    });
    expect(
      (await embedded.status('default')).pendingEmbeddings,
    ).toBeGreaterThan(0);
    expect(await embeddingsForPage(channelPage!.id)).toHaveLength(0);

    const result = await runBrainDreamBatch({
      brain,
      repository: repo,
      appId: 'default',
      proposer: {
        propose: async ({ pages }) => dreamOps(pages[0]!.id),
      },
    });
    expect(result).toMatchObject({ pages: 1, applied: 4, noop: 1 });

    const factPage = await brain.getPageBySlug(
      'default',
      'fact-alice-works-at-acme',
    );
    expect(factPage).toMatchObject({ sourceKind: 'dream' });
    expect(factPage?.metadata.evidence_page_ids).toEqual([channelPage!.id]);
    expect(await repo.findPeopleWorkingAt('default', 'Acme')).toMatchObject([
      { person: { name: 'Alice' }, page: { id: channelPage!.id } },
    ]);

    const decisions = await decisionsForRun(result.runId);
    expect(decisions).toHaveLength(5);
    expect(decisions.map((decision) => decision.outcome).sort()).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
      'noop',
    ]);
    expect(await repo.getDreamCursor('default')).toMatchObject({
      pageId: channelPage!.id,
    });

    const beforeRepeat = await rowCounts();
    await applyBrainDreamOperations({
      brain,
      repository: repo,
      appId: 'default',
      runId: 'repeat-dream',
      page: channelPage!,
      evidencePages: [channelPage!],
      ops: dreamOps(channelPage!.id),
    });
    expect(await rowCounts()).toEqual(beforeRepeat);
    expect(
      (await decisionsForRun('repeat-dream')).every(
        (decision) => decision.outcome === 'noop',
      ),
    ).toBe(true);

    await runBrainEmbeddingBackfill({
      brain: embedded,
      appId: 'default',
      limit: 20,
    });
    expect(await embeddingsForPage(channelPage!.id)).toMatchObject([
      { status: 'ready' },
    ]);
    expect((await embedded.status('default')).pendingEmbeddings).toBe(0);
  });

  it('stops between dream items and leaves the cursor retry-safe', async () => {
    const first = (
      await brain.write({
        appId: 'default',
        slug: 'abort-first',
        markdown: '# Abort first',
        sourceKind: 'channel',
        embed: false,
      })
    ).page;
    const second = (
      await brain.write({
        appId: 'default',
        slug: 'abort-second',
        markdown: '# Abort second',
        sourceKind: 'channel',
        embed: false,
      })
    ).page;
    await runtime.service.db
      .update(pgSchema.brainPagesPostgres)
      .set({ updatedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(pgSchema.brainPagesPostgres.id, first.id));
    await runtime.service.db
      .update(pgSchema.brainPagesPostgres)
      .set({ updatedAt: '2099-01-01T00:00:01.000Z' })
      .where(eq(pgSchema.brainPagesPostgres.id, second.id));

    const cursorBefore = await repo.getDreamCursor('default');
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runBrainDreamBatch({
        brain,
        repository: repo,
        appId: 'default',
        proposer: {
          propose: async () => {
            calls += 1;
            controller.abort(new Error('stop after first dream page'));
            return [];
          },
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop after first dream page');

    // Aborting during a page's proposal must not consume that page: the
    // cursor stays where it was so the retry re-dreams it.
    expect(calls).toBe(1);
    expect(await repo.getDreamCursor('default')).toEqual(cursorBefore);
    await expect(
      runBrainDreamBatch({
        brain,
        repository: repo,
        appId: 'default',
        proposer: { propose: async () => [] },
      }),
    ).resolves.toMatchObject({ pages: 2 });
    expect(await repo.getDreamCursor('default')).toMatchObject({
      pageId: second.id,
    });
  });
});

function dreamOps(evidencePageId: string): unknown[] {
  return [
    { action: 'upsert_entity', kind: 'person', name: 'Alice' },
    { action: 'upsert_entity', kind: 'company', name: 'Acme' },
    {
      action: 'upsert_edge',
      type: 'works_at',
      from: { kind: 'person', name: 'Alice' },
      to: { kind: 'company', name: 'Acme' },
      evidencePageId,
    },
    {
      action: 'write_fact_page',
      topic: 'Alice works at Acme',
      markdown: 'Alice works at Acme.',
      evidencePageIds: [evidencePageId],
    },
    {
      action: 'enrich_entity_page',
      kind: 'person',
      name: 'Alice',
      markdown: 'Alice works at Acme.',
      evidencePageIds: [evidencePageId],
    },
  ];
}

async function rowCounts() {
  const status = await brainForHelpers.status('default');
  return {
    pages: status.pages,
    entities: status.entities,
    edges: status.edges,
  };
}

async function decisionsForRun(runId: string) {
  return runtimeForHelpers.service.db
    .select()
    .from(pgSchema.brainDreamDecisionsPostgres)
    .where(eq(pgSchema.brainDreamDecisionsPostgres.runId, runId));
}

async function embeddingsForPage(pageId: string) {
  return runtimeForHelpers.service.db
    .select({
      status: pgSchema.brainPageEmbeddingsPostgres.status,
    })
    .from(pgSchema.brainPageEmbeddingsPostgres)
    .where(eq(pgSchema.brainPageEmbeddingsPostgres.pageId, pageId));
}

function vectorFor(text: string): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  vector[/acme|alice/i.test(text) ? 0 : 1] = 1;
  return vector;
}

function channelMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    chat_jid: 'sl:C123',
    providerAccountId: 'slack_one',
    sender: 'U1',
    sender_name: 'Alice',
    content: 'Alice works at Acme.',
    timestamp: '2026-07-07T01:00:00.000Z',
    thread_id: 'T1',
    ...overrides,
  };
}

function settingsWithHarvest(enabled: boolean) {
  return {
    providerAccounts: {
      slack_one: {
        agentId: 'main_agent',
        provider: 'slack',
        label: 'Slack',
        runtimeSecretRefs: {},
      },
    },
    conversations: {
      sales: {
        providerAccount: 'slack_one',
        externalId: 'C123',
        kind: 'channel',
        displayName: 'Sales',
        brainHarvest: enabled,
        senderPolicy: { allow: '*', mode: 'trigger' },
        controlApprovers: [],
        installedAgents: {},
      },
    },
  } as never;
}

let runtimeForHelpers: PostgresIntegrationRuntime;
let brainForHelpers: BrainService;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PostgresBrainRepository as BrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import type { BrainDreamProposal } from '@core/brain/brain-dreaming.js';
import type { BrainService as Brain } from '@core/brain/brain-service.js';
import { resolveObserverOwnerRoute } from '@core/config/settings/observer-activation.js';
import { createResolveObserverStatus } from '@core/application/control-plane/control-plane-storage-model.js';
import {
  loadRuntimeSettings,
  RUNTIME_MEMORY_DREAMING_ENABLED,
  RUNTIME_MEMORY_ENABLED,
} from '@core/config/index.js';
import {
  isObserverSubjectKey,
  type ObserverSubjectKey,
} from '@core/domain/ports/observer-insights.js';
import { listObserverActiveMemoryValues } from '@core/memory/app-memory-item-queries.js';
import {
  memoryAgentIdForWorkspaceFolder,
  subjectIdFor,
} from '@core/memory/app-memory-boundaries.js';
import type { EmbeddingProvider } from '@core/memory/memory-embeddings.js';
import { resolveScopedMemorySubject } from '@core/memory/app-memory-subject-resolver.js';

import {
  createDefaultRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { createClient } from '../../../../packages/sdk/src/index.js';

import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;
const TOKEN = 'observer-e2e-token';
const DIMENSIONS = 1536;
const MODEL = 'text-embedding-3-small';
const OBSERVED_SUBJECT = 'conversation:tg:observed-channel' as const;

maybeDescribe('observer Control API SDK round trip (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let server: { baseUrl: string; close(): Promise<void> };
  let runtimeHome: string;
  let previousRuntimeHome: string | undefined;
  let brainRepository: BrainRepository;
  let brain: Brain;
  let embedding: EmbeddingProvider;
  let cursorSubject: ObserverSubjectKey;
  let runBrainDreamBatch: typeof import('@core/brain/brain-dreaming.js').runBrainDreamBatch;
  let observedSubject: ObserverSubjectKey;
  const buildObserverPort = () => {
    const snapshot = loadRuntimeSettings(runtimeHome);
    return createResolveObserverStatus({
      getEffectiveRuntimeSettings: () => snapshot as never,
      getInternalRuntimeSettings: () => snapshot as never,
      getEffectiveMemoryState: () => ({
        enabled: snapshot.memory?.enabled ?? RUNTIME_MEMORY_ENABLED,
        dreamingEnabled:
          snapshot.memory?.dreaming?.enabled ?? RUNTIME_MEMORY_DREAMING_ENABLED,
      }),
      conversations: runtime.repositories.conversations,
    });
  };
  const settings = createDefaultRuntimeSettings();

  beforeAll(async () => {
    previousRuntimeHome = process.env.GANTRY_HOME;
    runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-observer-control-e2e-'),
    );
    process.env.GANTRY_HOME = runtimeHome;
    const { createPostgresIntegrationRuntime } =
      await import('../harness/postgres-integration-runtime.js');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_control_e2e',
    });
    settings.providers.telegram = { enabled: true };
    settings.observer = {
      enabled: false,
      owner: { recipient: 'owner-1', conversation: 'owner_dm' },
    };
    settings.memory.enabled = true;
    settings.memory.dreaming.enabled = true;
    settings.memory.embeddings.enabled = true;
    settings.memory.embeddings.provider = 'openai';
    settings.memory.embeddings.model = MODEL;
    settings.memory.embeddings.dimensions = DIMENSIONS;
    settings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      model: 'opus',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    };
    settings.providerAccounts.telegram_default = {
      agentId: 'main_agent',
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.owner_dm = {
      providerAccount: 'telegram_default',
      externalId: 'tg:owner-1',
      kind: 'dm',
      displayName: 'Owner DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['owner-1'],
    };

    const owner = resolveObserverOwnerRoute(settings);
    if (!owner.ok) throw new Error(`Observer owner failed: ${owner.reason}`);
    saveRuntimeSettings(runtimeHome, settings);
    vi.resetModules();
    const [
      { _setRuntimeStorageForTest },
      { startTestControlServer },
      { PostgresBrainRepository },
      { BrainService },
      { runBrainDreamBatch: runBatch },
      { OBSERVER_CURSOR_SUBJECT },
      { CachedEmbeddingProvider },
      { PostgresEmbeddingCacheStore },
    ] = await Promise.all([
      import('@core/adapters/storage/postgres/runtime-store.js'),
      import('../harness/control-http-server.js'),
      import('@core/adapters/storage/postgres/repositories/brain-repository.postgres.js'),
      import('@core/brain/brain-service.js'),
      import('@core/brain/brain-dreaming.js'),
      import('@core/brain/observer-insight-emission.js'),
      import('@core/memory/memory-embedding-cache.js'),
      import('@core/memory/memory-embedding-cache-store.js'),
    ]);
    _setRuntimeStorageForTest(runtime.storageRuntime);
    brainRepository = new PostgresBrainRepository(runtime.service.db);
    brain = new BrainService(brainRepository);
    embedding = new CachedEmbeddingProvider(
      fakeEmbeddingProvider,
      new PostgresEmbeddingCacheStore(runtime.service.db),
      MODEL,
      DIMENSIONS,
    );
    cursorSubject = OBSERVER_CURSOR_SUBJECT;
    runBrainDreamBatch = runBatch;
    const now = '2026-07-21T00:00:00.000Z';
    const conversationId = 'conversation:telegram_default:tg:owner-1' as never;
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: 'telegram_default' as never,
      appId: 'default' as never,
      agentId: 'agent:main_agent' as never,
      providerId: 'telegram' as never,
      label: 'Telegram',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId: 'default' as never,
      providerAccountId: 'telegram_default' as never,
      externalRef: { kind: 'conversation', value: 'tg:owner-1' },
      kind: 'direct',
      title: 'Owner DM',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const graph = new PostgresCanonicalGraphRepository(runtime.service.db);
    await graph.ensureParticipant({
      conversationId,
      providerId: 'telegram',
      providerAccountId: 'telegram_default',
      externalUserId: 'owner-1',
      timestamp: now,
    });
    await runtime.repositories.conversations.replaceConversationApprovers({
      appId: 'default' as never,
      conversationId,
      externalUserIds: ['owner-1'],
      updatedAt: now,
    });
    server = await startTestControlServer({
      token: TOKEN,
      appId: 'default',
      scopes: ['memory:read'],
      resolveObserverStatus: buildObserverPort(),
    });
  }, 60_000);

  afterAll(async () => {
    if (server) await server.close();
    if (runtime) await runtime.cleanup();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
    if (previousRuntimeHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = previousRuntimeHome;
  });

  it('emits a floored insight and lists it through the enabled Control API and SDK', async () => {
    let client = createClient({ apiKey: TOKEN, baseUrl: server.baseUrl });

    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: false,
      activation: 'disabled',
      counts: { insights: 0, pendingInsights: 0 },
    });

    settings.observer.enabled = true;
    saveRuntimeSettings(runtimeHome, settings);
    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: false,
      activation: 'disabled',
    });

    await server.close();
    const { startTestControlServer } =
      await import('../harness/control-http-server.js');
    server = await startTestControlServer({
      token: TOKEN,
      appId: 'default',
      scopes: ['memory:read'],
      resolveObserverStatus: buildObserverPort(),
    });
    client = createClient({ apiKey: TOKEN, baseUrl: server.baseUrl });
    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: true,
      activation: 'active',
      dreamingEnabled: true,
      message: 'Observer is active.',
      owner: {
        recipient: 'owner-1',
        conversation: 'owner_dm',
        conversationJid: 'tg:owner-1',
      },
      counts: { insights: 0, pendingInsights: 0 },
    });

    const { page } = await brain.write({
      appId: 'default',
      slug: 'observer-e2e-source',
      markdown: '# Observed channel\nThe team committed to ship the follow-up.',
      sourceKind: 'channel',
      sourceRef:
        'telegram_default:tg:observed-channel#2026-07-22T00:00:00.000Z',
      embed: false,
    });
    const result = await runBrainDreamBatch({
      brain,
      repository: brainRepository,
      appId: 'default',
      proposer: {
        propose: async ({ pages }): Promise<BrainDreamProposal> => ({
          operations: [],
          surfaceableInsights: [
            {
              insightType: 'commitment',
              title: 'Ship the follow-up',
              summary: 'The team committed to ship the follow-up.',
              canonicalSignature: 'ship the follow-up',
              confidence: 0.95,
              evidencePageIds: [pages[0]!.id],
            },
            {
              insightType: 'open_question',
              title: 'Unanswered budget question',
              summary: 'The budget question is still open.',
              canonicalSignature: 'unanswered budget question',
              confidence: 0.59,
              evidencePageIds: [pages[0]!.id],
            },
          ],
        }),
      },
      observer: {
        enabled: true,
        ownerRecipient: 'owner-1',
        cursorSubject,
        repository: runtime.repositories.observerInsights,
        patterns: runtime.repositories.patternCandidates,
        activeMemory: {
          listActiveValues: (input) =>
            listObserverActiveMemoryValues({
              db: runtime.service.db,
              ...input,
            }),
        },
        embedding,
        embeddingModel: MODEL,
        embeddingDimensions: DIMENSIONS,
      },
    });
    expect(result.observer).toMatchObject({ persisted: 1, filtered: 1 });

    await expect(client.observer.status()).resolves.toMatchObject({
      enabled: true,
      activation: 'active',
      counts: { evidence: 1, insights: 1, pendingInsights: 1 },
    });

    const listed = await client.observer.insights({
      subject: OBSERVED_SUBJECT,
      type: 'commitment',
      state: 'pending',
    });
    expect(listed.nextCursor).toBeNull();
    expect(listed.insights).toHaveLength(1);
    expect(listed.insights[0]).toMatchObject({
      subject: OBSERVED_SUBJECT,
      insightType: 'commitment',
      title: 'Ship the follow-up',
      state: 'pending',
      confidence: 0.95,
      evidenceRefs: [
        {
          conversationId: OBSERVED_SUBJECT,
          messageId: page.id,
          ts: page.updatedAt,
        },
      ],
    });
  });
});

const fakeEmbeddingProvider: EmbeddingProvider = {
  isEnabled: () => true,
  validateConfiguration: () => undefined,
  expectedDimensions: () => DIMENSIONS,
  embedMany: async (texts) => texts.map(vectorFor),
  embedOne: async (text) => vectorFor(text),
};

function vectorFor(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[text.includes('budget') ? 1 : 0] = 1;
  return vector;
}

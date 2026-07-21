import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// The deterministic fallback keeps automatic memory collection and dreaming
// enabled while disabling all live embedding dependencies.
vi.mock('@core/config/memory.js', async () => {
  const actual = await vi.importActual<typeof import('@core/config/memory.js')>(
    '@core/config/memory.js',
  );
  return {
    ...actual,
    RUNTIME_MEMORY_ENABLED: true,
    RUNTIME_MEMORY_DREAMING_ENABLED: true,
    MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
    MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
    MEMORY_EMBED_PROVIDER: 'disabled',
  };
});

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { PostgresStorageService } from '@core/adapters/storage/postgres/storage-service.js';
import { collectDurableMemoryAtBoundary } from '@core/memory/app-memory-session-boundary-collector.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { processMemoryRequest } from '@core/memory/memory-ipc.js';
import { registerMemoryLlmClient } from '@core/memory/memory-llm-port.js';
import type { MemoryIpcResponse } from '@gantry/contracts';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const AGENT_FOLDER = 'main_agent';
const CHAT_JID = 'tg:memory-lifecycle';
const SEARCH_TOKEN = 'cobalt-orchard-7319';
const TURN_CONTEXT = {
  chatJid: CHAT_JID,
  defaultScope: 'group' as const,
};

const unconfiguredMemoryLlm = {
  isConfigured: () => false,
  query: async () => '[]',
};

function recalledMemoryIds(response: MemoryIpcResponse): string[] {
  const data = response.data as
    | { results?: Array<{ item?: { id?: string } }> }
    | undefined;
  return (data?.results ?? [])
    .map((result) => result.item?.id)
    .filter((id): id is string => Boolean(id));
}

async function recallCount(
  service: PostgresStorageService,
  itemId: string,
): Promise<number> {
  const rows = await service.db
    .select({ id: pgSchema.memoryRecallEventsPostgres.id })
    .from(pgSchema.memoryRecallEventsPostgres)
    .where(eq(pgSchema.memoryRecallEventsPostgres.itemId, itemId));
  return rows.length;
}

// Matrix §8 deterministic seam fallback. E2E_ANTHROPIC_API_KEY is not
// available in this environment, so a reliable real-model gate cannot run.
// Instead, a real persisted session transcript enters the production boundary
// collector through a scripted MemoryLlmClient, structured evidence is promoted
// by the real dreaming service, and later scripted turns use the production
// memory_search IPC action. This remains distinct from the service-level
// subject-isolation coverage in memory-write-recall-boundary.postgres.integration.test.ts.
maybeDescribe('memory turn lifecycle (Postgres scripted-turn seam)', () => {
  let runtime: PostgresIntegrationRuntime;
  let restartedService: PostgresStorageService | undefined;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'memory_lifecycle',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    AppMemoryService.resetForTest();
    registerMemoryLlmClient(unconfiguredMemoryLlm);
  }, 60_000);

  afterAll(async () => {
    registerMemoryLlmClient(unconfiguredMemoryLlm);
    AppMemoryService.resetForTest();
    if (runtime) _setRuntimeStorageForTest(runtime.storageRuntime);
    await restartedService?.close();
    await runtime?.cleanup();
  });

  it('collects a channel memory from turn 1, records turn-2 recall, and recalls after restart', async () => {
    const turnContext = await runtime.ops.getAgentTurnContext({
      appId: 'default',
      agentFolder: AGENT_FOLDER,
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      conversationJid: CHAT_JID,
      conversationKind: 'channel',
      hydrateMemory: false,
    });
    const session = await runtime.repositories.agentSessions.getAgentSession(
      turnContext.agentSessionId as never,
    );
    if (!session?.conversationId) {
      throw new Error('Expected a durable agent session and conversation.');
    }

    await runtime.repositories.messages.saveMessage({
      id: 'message:memory-lifecycle:turn-1-user' as never,
      appId: session.appId,
      conversationId: session.conversationId,
      direction: 'inbound',
      senderDisplayName: 'Memory Lifecycle User',
      trust: 'trusted',
      createdAt: '2026-07-21T00:00:00.000Z' as never,
      parts: [
        {
          kind: 'text',
          text: `Remember that the durable marker is ${SEARCH_TOKEN}.`,
        },
      ],
      attachments: [],
    });
    await runtime.repositories.messages.saveMessage({
      id: 'message:memory-lifecycle:turn-1-assistant' as never,
      appId: session.appId,
      conversationId: session.conversationId,
      direction: 'outbound',
      senderDisplayName: 'Gantry',
      trust: 'system',
      createdAt: '2026-07-21T00:00:01.000Z' as never,
      deliveryStatus: 'sent',
      parts: [{ kind: 'text', text: 'The durable fact was acknowledged.' }],
      attachments: [],
    });
    const persistedTurns =
      await runtime.repositories.messages.listRecentMessages({
        conversationId: session.conversationId,
        threadId: session.threadId,
        limit: 10,
      });
    expect(persistedTurns).toHaveLength(2);
    expect(persistedTurns.map((message) => message.direction).sort()).toEqual([
      'inbound',
      'outbound',
    ]);

    const extractorQueries: unknown[] = [];
    registerMemoryLlmClient({
      isConfigured: () => true,
      query: async (options) => {
        extractorQueries.push(options);
        return JSON.stringify([
          {
            kind: 'fact',
            scope: 'group',
            key: 'fact:memory-lifecycle-marker',
            value: `The durable marker is ${SEARCH_TOKEN}.`,
            confidence: 1,
            why: `The durable marker is ${SEARCH_TOKEN}.`,
          },
        ]);
      },
    });
    const memory = AppMemoryService.getInstance();
    const collected = await collectDurableMemoryAtBoundary(
      {
        agentSessionId: turnContext.agentSessionId,
        trigger: 'session-end',
        defaultScope: 'group',
      },
      {
        repositories: runtime.repositories,
        memory: {
          recordEvidence: (value) => memory.recordEvidence(value),
        },
      },
    );
    expect(collected).toEqual({ saved: 1 });
    expect(extractorQueries).toHaveLength(1);

    const evidenceRows = await runtime.service.db
      .select()
      .from(pgSchema.memoryEvidencePostgres);
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({
      appId: session.appId,
      agentId: session.agentId,
      subjectType: 'channel',
      sourceType: 'session',
    });

    registerMemoryLlmClient(unconfiguredMemoryLlm);
    const evidence = evidenceRows[0]!;
    const dream = await memory.triggerDreaming({
      appId: evidence.appId,
      agentId: evidence.agentId,
      subjectType: evidence.subjectType as 'channel',
      subjectId: evidence.subjectId,
      ...(evidence.groupId ? { groupId: evidence.groupId } : {}),
      ...(evidence.channelId ? { channelId: evidence.channelId } : {}),
      phase: 'all',
      dryRun: false,
    });
    expect(dream.status).toBe('completed');

    const activeItems = await runtime.service.db
      .select({
        id: pgSchema.memoryItemsPostgres.id,
        agentId: pgSchema.memoryItemsPostgres.agentId,
        subjectType: pgSchema.memoryItemsPostgres.subjectType,
        status: pgSchema.memoryItemsPostgres.status,
      })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.agentId, session.agentId),
          eq(pgSchema.memoryItemsPostgres.status, 'active'),
        ),
      );
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0]).toMatchObject({
      agentId: session.agentId,
      subjectType: 'channel',
      status: 'active',
    });
    const itemId = activeItems[0]!.id;

    const turnTwo = await processMemoryRequest(
      {
        requestId: 'memory-lifecycle-turn-2-search',
        action: 'memory_search',
        payload: { query: SEARCH_TOKEN, limit: 10 },
        context: TURN_CONTEXT,
      },
      AGENT_FOLDER,
    );
    expect(turnTwo.ok).toBe(true);
    expect(recalledMemoryIds(turnTwo)).toContain(itemId);
    const recallsBeforeRestart = await recallCount(runtime.service, itemId);
    expect(recallsBeforeRestart).toBeGreaterThan(0);

    restartedService = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL!,
      runtime.schemaName,
    );
    AppMemoryService.resetForTest();
    _setRuntimeStorageForTest({
      ...runtime.storageRuntime,
      service: restartedService,
    });

    const persistedRows = await restartedService.db
      .select({ id: pgSchema.memoryItemsPostgres.id })
      .from(pgSchema.memoryItemsPostgres)
      .where(eq(pgSchema.memoryItemsPostgres.id, itemId));
    expect(persistedRows).toEqual([{ id: itemId }]);

    const postRestartTurn = await processMemoryRequest(
      {
        requestId: 'memory-lifecycle-post-restart-search',
        action: 'memory_search',
        payload: { query: SEARCH_TOKEN, limit: 10 },
        context: TURN_CONTEXT,
      },
      AGENT_FOLDER,
    );
    expect(postRestartTurn.ok).toBe(true);
    expect(recalledMemoryIds(postRestartTurn)).toContain(itemId);
    expect(await recallCount(restartedService, itemId)).toBeGreaterThan(
      recallsBeforeRestart,
    );
  });
});

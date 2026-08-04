import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { buildLiveAdmissionProcessor } from '@core/app/bootstrap/live-execution.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
import { startLiveAdmissionWorkLoop } from '@core/runtime/live-admission-work-loop.js';
import { LiveTurnAuthority } from '@core/runtime/live-turn-authority.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('route integrity corrupt-state recovery (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'route_integrity_corrupt',
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('collapses corrupt database route aliases and admits exactly one live turn', async () => {
    const chatJid = 'tg:route-integrity-corrupt';
    const providerAccountId =
      'provider-account:route-integrity' as ProviderAccountId;
    const legacyConversationId = 'legacy-route-integrity-conversation';
    const canonicalConversationId = `conversation:${providerAccountId}:${chatJid}`;
    const agentQualifiedRouteKey = makeAgentThreadQueueKey(
      chatJid,
      'main_agent',
    );
    const fullyQualifiedRouteKey = makeAgentThreadQueueKey(
      chatJid,
      DEFAULT_AGENT_ID,
      undefined,
      providerAccountId,
    );
    const workerInstanceId = 'worker-route-integrity-corrupt';
    const table = (name: string): string =>
      `${quotePostgresIdentifier(runtime.schemaName)}.${quotePostgresIdentifier(name)}`;

    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId: DEFAULT_APP_ID as AppId,
      agentId: DEFAULT_AGENT_ID as AgentId,
      providerId: 'telegram' as ProviderId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: providerAccountId,
      },
      label: 'Route integrity Telegram account',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });

    // Matrix §11 sanctions direct test-DB corruption here. Repository,
    // desired-state, admission persistence, and message qualification are
    // already covered by canonical-binding-repository.test.ts,
    // settings-desired-state-service.test.ts,
    // live-admission-work-items.postgres.integration.test.ts, and
    // canonical-message-ops-service.test.ts; this test alone seeds rows that
    // bypass those APIs and arrive through the real PostgreSQL loader.
    await runtime.service.pool.query(
      `INSERT INTO ${table('conversations')} (
         id, app_id, provider_account_id, external_ref_json, kind, title,
         status, created_at, updated_at
       )
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $8),
         ($9, $2, $3, $4, $5, $10, $7, $8, $8)`,
      [
        canonicalConversationId,
        DEFAULT_APP_ID,
        providerAccountId,
        JSON.stringify({ jid: chatJid }),
        'group',
        'Canonical route integrity conversation',
        'active',
        '2026-07-21T00:00:00.000Z',
        legacyConversationId,
        'Legacy route integrity conversation',
      ],
    );
    await runtime.service.pool.query(
      `INSERT INTO ${table('conversation_installs')} (
         id, app_id, agent_id, provider_account_id, conversation_id, thread_id,
         display_name, status, sender_policy, control_policy, memory_scope,
         memory_subject_json, permission_policy_ids_json, created_at, updated_at
       )
       SELECT seeded.id, $1, $2, $3, seeded.conversation_id, NULL, $4,
              'active', 'provider_native', 'conversation_approvers',
              'conversation', $5, '[]', $6, seeded.updated_at
       FROM (VALUES
         ($7::text, $8::text, $9::timestamptz),
         ($10::text, $8::text, $11::timestamptz),
         ($12::text, $13::text, $14::timestamptz)
       ) AS seeded(id, conversation_id, updated_at)`,
      [
        DEFAULT_APP_ID,
        DEFAULT_AGENT_ID,
        providerAccountId,
        'Route integrity conversation',
        JSON.stringify({
          route: { trigger: '@main', requiresTrigger: false },
        }),
        '2026-07-21T00:00:00.000Z',
        `conversation-route:${chatJid}`,
        legacyConversationId,
        '2026-07-21T00:03:00.000Z',
        `conversation-route:${agentQualifiedRouteKey}`,
        '2026-07-21T00:02:00.000Z',
        `conversation-route:${fullyQualifiedRouteKey}`,
        canonicalConversationId,
        '2026-07-21T00:01:00.000Z',
      ],
    );

    const routes = await runtime.ops.getAllConversationRoutes();
    expect(Object.keys(routes)).toEqual([fullyQualifiedRouteKey]);
    expect(routes[fullyQualifiedRouteKey]).toMatchObject({
      folder: 'main_agent',
      conversationId: canonicalConversationId,
      providerAccountId,
      requiresTrigger: false,
    });

    const admission = await runtime.ops.storeMessageWithLiveAdmission?.(
      {
        id: 'route-integrity-message-1',
        chat_jid: chatJid,
        provider: 'telegram',
        sender: 'route-integrity-user',
        sender_name: 'Route Integrity User',
        content: 'admit this durable route-integrity turn',
        timestamp: '2026-07-21T00:04:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
      {
        appId: DEFAULT_APP_ID,
        agentId: 'main_agent',
        triggerDecision: {
          source: 'channel_persistence',
          requiresTrigger: false,
        },
      },
    );
    expect(admission).toMatchObject({
      outcome: 'enqueued',
      item: {
        queueJid: fullyQualifiedRouteKey,
        conversationId: chatJid,
        state: 'queued',
      },
    });
    if (!admission) throw new Error('Expected a live admission work item.');

    await runtime.repositories.workerCoordination.registerWorker({
      id: workerInstanceId,
      bootNonce: 'route-integrity-corrupt',
    });
    const liveTurnAuthority = new LiveTurnAuthority({
      leaseDeps: {
        liveTurns: runtime.repositories.liveTurns,
        coordination: runtime.repositories.workerCoordination,
        workerInstanceId,
      },
      slotCapacity: () => 1,
      leaseTtlMs: 60_000,
      ownerPollMs: 60_000,
    });
    const queue = new GroupQueue({
      maxMessageRuns: 1,
      maxJobRuns: 1,
      maxRetries: 0,
      baseRetryMs: 1,
    });
    const processGroupMessages = vi.fn(async () => true);
    const getOrRecoverCursor = async () => '';
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority,
      app: {
        getConversationRoutes: () => routes,
        processGroupMessages,
        getOrRecoverCursor,
        setAgentCursor: () => undefined,
        saveState: () => undefined,
      },
      opsRepository: runtime.ops,
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: (queueJid) => queue.enqueueMessageCheck(queueJid),
      warn: () => undefined,
    });
    queue.setProcessMessagesFn(processor);

    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: runtime.repositories.liveTurns,
      appId: DEFAULT_APP_ID,
      workerInstanceId,
      messageLoopDeps: {
        getConversationRoutes: () => routes,
        getOrRecoverCursor,
        setAgentCursor: () => undefined,
        saveState: () => undefined,
        hasChannel: (_jid, options) =>
          options?.providerAccountId === providerAccountId,
        setTyping: async () => undefined,
        sendProgressUpdate: async () => undefined,
        queue,
        opsRepository: runtime.ops,
      },
      claimLimit: 1,
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      warn: () => undefined,
    });

    try {
      await vi.waitFor(
        () => expect(processGroupMessages).toHaveBeenCalledOnce(),
        { timeout: 10_000, interval: 25 },
      );
      await vi.waitFor(
        async () => {
          const result = await runtime.service.pool.query<{ state: string }>(
            `SELECT state FROM ${table('live_admission_work_items')} WHERE id = $1`,
            [admission.item.id],
          );
          expect(result.rows).toEqual([{ state: 'completed' }]);
        },
        { timeout: 10_000, interval: 25 },
      );
      await vi.waitFor(
        async () => {
          const [runResult, liveTurnResult] = await Promise.all([
            runtime.service.pool.query<{ status: string }>(
              `SELECT status FROM ${table('agent_runs')}`,
            ),
            runtime.service.pool.query<{ state: string }>(
              `SELECT state FROM ${table('live_turns')}`,
            ),
          ]);
          expect(runResult.rows).toEqual([{ status: 'completed' }]);
          expect(liveTurnResult.rows).toEqual([{ state: 'completed' }]);
        },
        { timeout: 10_000, interval: 25 },
      );

      const [conversations, sessions, runs, liveTurns] = await Promise.all([
        runtime.service.pool.query<{ id: string }>(
          `SELECT id FROM ${table('conversations')}
           WHERE external_ref_json::jsonb->>'jid' = $1
           ORDER BY id`,
          [chatJid],
        ),
        runtime.service.pool.query<{
          id: string;
          conversation_id: string;
          status: string;
        }>(
          `SELECT id, conversation_id, status
           FROM ${table('agent_sessions')}
           WHERE agent_id = $1`,
          [DEFAULT_AGENT_ID],
        ),
        runtime.service.pool.query<{
          id: string;
          conversation_id: string;
          cause: string;
          status: string;
        }>(
          `SELECT id, conversation_id, cause, status
           FROM ${table('agent_runs')}`,
        ),
        runtime.service.pool.query<{
          run_id: string;
          conversation_id: string;
          state: string;
        }>(
          `SELECT run_id, conversation_id, state
           FROM ${table('live_turns')}`,
        ),
      ]);

      expect(processGroupMessages).toHaveBeenCalledTimes(1);
      expect(conversations.rows).toEqual([
        { id: canonicalConversationId },
        { id: legacyConversationId },
      ]);
      expect(sessions.rows).toEqual([
        expect.objectContaining({
          conversation_id: canonicalConversationId,
          status: 'active',
        }),
      ]);
      expect(runs.rows).toEqual([
        expect.objectContaining({
          conversation_id: canonicalConversationId,
          cause: 'message',
          status: 'completed',
        }),
      ]);
      expect(liveTurns.rows).toEqual([
        {
          run_id: runs.rows[0]?.id,
          conversation_id: chatJid,
          state: 'completed',
        },
      ]);
    } finally {
      await loop.stop({ drainDeadlineMs: 5_000 });
      await loop.done;
      await queue.shutdown(5_000);
      await liveTurnAuthority.shutdown();
    }
  }, 30_000);
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { conversationIdForJid } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  ConversationId,
  UserId,
} from '@core/domain/conversation/conversation.js';
import type { MessageId } from '@core/domain/messages/messages.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import { processLiveAdmissionWorkItem } from '@core/runtime/message-loop.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('worker restart route recovery (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'worker_route_recovery',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('processes a pending message after reloading a non-default app route', async () => {
    const now = '2026-09-29T00:00:00.000Z';
    const appId = 'route-recovery-app' as AppId;
    const agentId = 'agent:route_recovery' as AgentId;
    const providerAccountId = 'account:route-recovery' as ProviderAccountId;
    const chatJid = 'tg:route-recovery';
    const conversationId = conversationIdForJid(chatJid, providerAccountId);
    const queueJid = makeAgentThreadQueueKey(
      chatJid,
      agentId,
      null,
      providerAccountId,
    );
    const messageId = 'message:route-recovery' as MessageId;

    await runtime.repositories.apps.saveApp({
      id: appId,
      slug: 'route-recovery',
      name: 'Route Recovery',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId,
      name: 'Route Recovery Agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId,
      providerId: 'telegram' as ProviderId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: providerAccountId,
      },
      label: 'Route Recovery Telegram',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: conversationId as ConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: chatJid },
      kind: 'channel',
      title: 'Route Recovery Chat',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.providerAccounts.saveConversationInstall({
      id: `conversation-route:${queueJid}`,
      appId,
      agentId,
      providerAccountId,
      conversationId: conversationId as ConversationId,
      displayName: 'Route Recovery Chat',
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId,
        conversationId,
        route: { requiresTrigger: false },
      },
      permissionPolicyIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.messages.saveMessage({
      id: messageId,
      appId,
      conversationId: conversationId as ConversationId,
      externalRef: { kind: 'message', value: 'route-recovery-message' },
      direction: 'inbound',
      senderUserId: 'route-recovery-user' as UserId,
      senderDisplayName: 'User',
      trust: 'trusted',
      createdAt: now,
      receivedAt: now,
      parts: [{ kind: 'text', text: 'Please answer after restart' }],
      attachments: [],
    });
    const admission =
      await runtime.repositories.liveTurns.enqueueLiveAdmissionWorkItem({
        id: 'work:route-recovery',
        appId,
        agentId,
        conversationId: chatJid,
        threadId: null,
        providerAccountId,
        queueJid,
        messageId,
        messageCursor: `${now}::route-recovery-message`,
        idempotencyKey: 'route-recovery-message',
        triggerDecision: {
          source: 'channel_persistence',
          requiresTrigger: false,
        },
        now,
      });
    expect(admission.outcome).toBe('enqueued');
    if (admission.outcome !== 'enqueued') return;

    const app = createRuntimeApp({
      opsRepository: runtime.ops,
      runAgent: vi.fn() as never,
    });
    await app.loadState();
    expect(app.getConversationRoutes()[queueJid]).toMatchObject({
      conversationId,
      providerAccountId,
    });
    const sendMessage = vi.fn(() => true);
    const result = await processLiveAdmissionWorkItem(
      {
        getConversationRoutes: app.getConversationRoutes,
        getOrRecoverCursor: app.getOrRecoverCursor,
        setAgentCursor: app.setAgentCursor,
        saveState: app.saveState,
        hasChannel: () => true,
        setTyping: async () => undefined,
        sendProgressUpdate: async () => undefined,
        queue: {
          sendMessage,
          enqueueMessageCheck: () => undefined,
          closeStdin: () => undefined,
        },
        opsRepository: runtime.ops,
      },
      admission.item,
    );
    expect(result).toBe('completed');
    expect(sendMessage).toHaveBeenCalledWith(
      queueJid,
      expect.stringContaining('Please answer after restart'),
      expect.any(Object),
    );
  });
});

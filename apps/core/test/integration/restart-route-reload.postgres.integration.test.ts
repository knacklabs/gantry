import { describe, expect, it, vi } from 'vitest';

import { conversationIdForJid } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { runStartup } from '@core/app/bootstrap/startup.js';
import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
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
import { GroupQueue } from '@core/runtime/group-queue.js';
import { startLiveAdmissionWorkLoop } from '@core/runtime/live-admission-work-loop.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const NOW = '2026-09-29T00:00:00.000Z';
const APP_ID = 'route-recovery-app' as AppId;
const AGENT_ID = 'agent:route_recovery' as AgentId;
const PROVIDER_ACCOUNT_ID = 'account:route-recovery' as ProviderAccountId;
const CHAT_JID = `app:${APP_ID}:chat`;
const CONVERSATION_ID = conversationIdForJid(
  CHAT_JID,
  PROVIDER_ACCOUNT_ID,
) as ConversationId;
const QUEUE_JID = makeAgentThreadQueueKey(
  CHAT_JID,
  AGENT_ID,
  null,
  PROVIDER_ACCOUNT_ID,
);
const MESSAGE_ID = 'message:route-recovery' as MessageId;

async function seedPendingRoute(
  runtime: PostgresIntegrationRuntime,
): Promise<void> {
  await runtime.repositories.apps.saveApp({
    id: APP_ID,
    slug: 'route-recovery',
    name: 'Route Recovery',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await runtime.repositories.agents.saveAgent({
    id: AGENT_ID,
    appId: APP_ID,
    name: 'Route Recovery Agent',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await runtime.repositories.providerAccounts.saveProviderAccount({
    id: PROVIDER_ACCOUNT_ID,
    appId: APP_ID,
    agentId: AGENT_ID,
    providerId: 'app' as ProviderId,
    externalIdentityRef: {
      kind: 'provider_account',
      value: PROVIDER_ACCOUNT_ID,
    },
    label: 'Route Recovery App',
    status: 'active',
    config: {},
    runtimeSecretRefs: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  await runtime.repositories.conversations.saveConversation({
    id: CONVERSATION_ID,
    appId: APP_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    externalRef: { kind: 'conversation', value: CHAT_JID },
    kind: 'channel',
    title: 'Route Recovery Chat',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await runtime.repositories.providerAccounts.saveConversationInstall({
    id: `conversation-route:${QUEUE_JID}`,
    appId: APP_ID,
    agentId: AGENT_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    conversationId: CONVERSATION_ID,
    displayName: 'Route Recovery Chat',
    status: 'active',
    senderPolicy: 'provider_native',
    controlPolicy: 'conversation_approvers',
    memoryScope: 'conversation',
    memorySubject: {
      kind: 'conversation',
      appId: APP_ID,
      conversationId: CONVERSATION_ID,
      route: { requiresTrigger: false },
    },
    permissionPolicyIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await runtime.repositories.messages.saveMessage({
    id: MESSAGE_ID,
    appId: APP_ID,
    conversationId: CONVERSATION_ID,
    externalRef: { kind: 'message', value: 'route-recovery-message' },
    direction: 'inbound',
    senderUserId: 'route-recovery-user' as UserId,
    senderDisplayName: 'User',
    trust: 'trusted',
    createdAt: NOW,
    receivedAt: NOW,
    parts: [{ kind: 'text', text: 'Please answer after restart' }],
    attachments: [],
  });
  const admission =
    await runtime.repositories.liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'work:route-recovery',
      appId: APP_ID,
      agentId: AGENT_ID,
      conversationId: CHAT_JID,
      threadId: null,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      queueJid: QUEUE_JID,
      messageId: MESSAGE_ID,
      messageCursor: `${NOW}::route-recovery-message`,
      idempotencyKey: 'route-recovery-message',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
      now: NOW,
    });
  expect(admission.outcome).toBe('enqueued');
}

maybeDescribe('worker restart route recovery (Postgres)', () => {
  it('keeps another app route during authoritative settings reconciliation', async () => {
    const runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'route_reconcile_scope',
    });
    try {
      await seedPendingRoute(runtime);
      const settings = createDefaultRuntimeSettings();
      settings.desiredState.authoritative = true;
      await new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
      }).reconcile(settings);

      expect(
        (await runtime.ops.getAllConversationRoutes())[QUEUE_JID],
      ).toBeDefined();
    } finally {
      await runtime.cleanup();
    }
  }, 60_000);

  it('processes a pending non-default app turn after worker startup', async () => {
    const runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'route_restart_turn',
    });
    const queue = new GroupQueue({
      maxMessageRuns: 1,
      maxJobRuns: 1,
      maxRetries: 0,
      baseRetryMs: 1,
    });
    let loop: ReturnType<typeof startLiveAdmissionWorkLoop> | undefined;
    try {
      await seedPendingRoute(runtime);
      _setRuntimeStorageForTest(runtime.storageRuntime);
      const settings = createDefaultRuntimeSettings();
      settings.desiredState.authoritative = true;
      settings.credentialBroker.mode = 'none';
      const channel = createFakeChannelRuntime((jid) => jid === CHAT_JID);
      const runAgent = vi.fn(async (_group, _input, _register, onOutput) => {
        await onOutput?.({ status: 'success', result: 'Recovered reply' });
        return { status: 'success', result: 'Recovered reply' };
      });
      const app = createRuntimeApp({
        queue,
        opsRepository: runtime.ops,
        runAgent: runAgent as never,
        ensureCredentialBinding: async () => ({ created: false }),
      });
      app.setChannelRuntime(channel.runtime);
      await runStartup(app, {
        ensureRuntimeLayoutDirectories: () => undefined,
        initializeRuntimeStorage: async () => runtime.storageRuntime,
        loadRuntimeSettings: () => settings,
        logger: { info: () => undefined, warn: () => undefined },
      });
      expect(app.getConversationRoutes()[QUEUE_JID]).toBeDefined();

      queue.setProcessMessagesFn((jid, options) =>
        app.processGroupMessages(jid, options),
      );
      const workerInstanceId = 'worker-route-recovery';
      await runtime.repositories.workerCoordination.registerWorker({
        id: workerInstanceId,
        bootNonce: 'route-recovery',
      });
      loop = startLiveAdmissionWorkLoop({
        liveAdmissions: runtime.repositories.liveTurns,
        appId: APP_ID,
        workerInstanceId,
        messageLoopDeps: {
          getConversationRoutes: app.getConversationRoutes,
          getOrRecoverCursor: app.getOrRecoverCursor,
          setAgentCursor: app.setAgentCursor,
          saveState: app.saveState,
          hasChannel: channel.runtime.hasChannel,
          setTyping: channel.runtime.setTyping,
          sendProgressUpdate: channel.runtime.sendProgressUpdate,
          queue,
          opsRepository: runtime.ops,
        },
        claimLimit: 1,
        intervalMs: 60_000,
        maxBatchesPerWake: 1,
        warn: () => undefined,
      });

      await vi.waitFor(
        () => {
          expect(runAgent).toHaveBeenCalledOnce();
          expect(channel.outbound).toEqual([
            expect.objectContaining({
              chatJid: CHAT_JID,
              text: 'Recovered reply',
            }),
          ]);
        },
        { timeout: 10_000, interval: 25 },
      );
      expect(
        (await runtime.ops.getAllConversationRoutes())[QUEUE_JID],
      ).toBeDefined();
    } finally {
      await loop?.stop();
      await queue.shutdown(500);
      await runtime.cleanup();
    }
  }, 60_000);
});

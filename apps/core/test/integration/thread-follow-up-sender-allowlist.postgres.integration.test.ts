import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EnvRuntimeSecretProvider } from '@core/adapters/credentials/env-runtime-secret-provider.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import {
  buildLiveAdmissionProcessor,
  startLiveExecutionServices,
} from '@core/app/bootstrap/live-execution.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { listChannelProviders } from '@core/channels/provider-registry.js';
import { GANTRY_HOME } from '@core/config/index.js';
import { settingsFilePath } from '@core/config/settings/runtime-home.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettingsFromPath,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import type { AppId } from '@core/domain/app/app.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import {
  invalidateSenderAllowlistCache,
  isSenderAllowed,
  isSenderControlAllowed,
  loadSenderAllowlist,
  loadSenderControlAllowlist,
  shouldLogDenied,
} from '@core/platform/sender-allowlist.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
import { LiveTurnAuthority } from '@core/runtime/live-turn-authority.js';
import { nowIso } from '@core/shared/time/datetime.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

maybeDescribe('thread follow-up sender allowlist (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  const settingsPath = settingsFilePath(GANTRY_HOME);
  let originalSettings: string | undefined;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'thread_sender_allowlist',
    });
    originalSettings = fs.readFileSync(settingsPath, 'utf-8');
  }, 60_000);

  afterAll(async () => {
    if (originalSettings !== undefined)
      fs.writeFileSync(settingsPath, originalSettings, 'utf-8');
    invalidateSenderAllowlistCache();
    await runtime?.cleanup();
  });

  it('answers a thread follow-up only when its sender may trigger the agent', async () => {
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const appId = 'default';
    const chatJid = 'tg:-4200';
    const folder = 'thread_sender_agent';
    const providerAccountId = 'channel-providerAccount:default:telegram';
    const threadId = '4242';
    await runtime.control.ensureAppSession({
      appId,
      conversationId: 'thread-sender-group',
      chatJid,
      workspaceFolder: folder,
    });

    // Real settings in the runtime home: only alice may trigger this agent.
    const settings = loadRuntimeSettingsFromPath(settingsPath);
    const { conversationId } = ensureConfiguredConversationBinding(settings, {
      agentId: folder,
      agentName: 'Thread sender agent',
      agentFolder: folder,
      jid: chatJid,
      displayName: 'Thread sender group',
      trigger: 'Andy',
      requiresTrigger: true,
    });
    settings.conversations[conversationId]!.senderPolicy = {
      allow: ['alice'],
      mode: 'trigger',
    };
    saveRuntimeSettings(GANTRY_HOME, settings);
    invalidateSenderAllowlistCache();

    const presented: string[] = [];
    const continued: string[] = [];
    // The second turn's runner stays alive after its answer, as a real one
    // does while it waits for follow-ups.
    let releaseRunner: () => void = () => undefined;
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const channel = createFakeChannelRuntime((jid) => jid === chatJid);
    const route = {
      name: 'Thread sender group',
      folder,
      providerAccountId,
      trigger: 'Andy',
      added_at: nowIso(),
      requiresTrigger: true,
      conversationKind: 'group' as const,
      agentConfig: { model: 'opus' },
    };
    // Two workers: a follow-up claimed by the worker that does not hold the
    // running turn is routed to that turn's owner.
    const startWorker = async (workerInstanceId: string) => {
      await runtime.repositories.workerCoordination.registerWorker({
        id: workerInstanceId,
        bootNonce: workerInstanceId,
      });
      const queue = new GroupQueue({
        maxMessageRuns: 1,
        maxJobRuns: 1,
        maxRetries: 0,
        baseRetryMs: 25,
        runnerControlPort: {
          writeContinuationInput: ({ text }) => {
            continued.push(text);
          },
          writeCloseSignal: () => undefined,
        },
      });
      const app = createRuntimeApp({
        queue,
        opsRepository: runtime.ops,
        ensureCredentialBinding: async () => ({ created: false }),
        runAgent: async (_group, input, onProcess, onOutput) => {
          presented.push(input.prompt);
          onProcess(
            {
              pid: 0,
              kill: () => true,
              stdin: { end: () => undefined },
            } as unknown as ChildProcess,
            'run',
          );
          const result = {
            status: 'success' as const,
            result: 'Thread reply.',
          };
          await onOutput?.(result);
          if (presented.length === 2) {
            // Turn done; the runner stays up waiting for follow-ups.
            await onOutput?.({ status: 'success', result: null });
            await runnerReleased;
          }
          return result;
        },
      });
      app.setChannelRuntime(channel.runtime);
      await app.registerGroup(chatJid, route);
      const leaseDeps = {
        liveTurns: runtime.repositories.liveTurns,
        coordination: runtime.repositories.workerCoordination,
        workerInstanceId,
      };
      const authority = new LiveTurnAuthority({
        leaseDeps,
        slotCapacity: () => 1,
        ownerPollMs: 25,
      });
      queue.setLiveTurnRunnerRegistrar((queueJid, hooks, routing) =>
        authority.registerLocalRunner(queueJid, hooks, routing),
      );
      const processor = buildLiveAdmissionProcessor({
        inputRepository: runtime.repositories.liveTurns,
        liveTurnAuthority: authority,
        app,
        opsRepository: runtime.ops,
        executionAdapter: { id: 'anthropic:claude-agent-sdk' },
        messageFetchPageSize: 50,
        timezone: 'UTC',
        enqueueMessageCheck: (queueJid) => {
          queue.enqueueMessageCheck(queueJid);
        },
        warn: () => undefined,
      });
      queue.setProcessMessagesFn((queueJid, context) =>
        processor(queueJid, context),
      );
      const handle = startLiveExecutionServices({
        appId,
        app,
        liveTurnAuthority: authority,
        liveTurnLeaseDeps: leaseDeps,
        messageLoopDeps: {
          appId,
          inputRepository: runtime.repositories.liveTurns,
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
        recoveryCoordinator: undefined,
        isEligibleToRecoverLiveTurn: () => true,
        alertNoEligibleLiveTurnRecoverer: undefined,
        registerActiveAdmissionLoop: () => undefined,
        registerActiveRecoveryLoop: () => undefined,
        onPollingCrash: (error) => {
          throw error;
        },
        info: () => undefined,
        warn: () => undefined,
      });
      return { app, queue, authority, handle };
    };
    const workers = [await startWorker('runtime-worker-thread-sender-a')];
    const app = workers[0]!.app;
    // The inbound entry point a connected channel calls, built as channel
    // wiring builds it.
    const inbound = createChannelPersistenceHandlers({
      app,
      resolved: {
        appId: appId as AppId,
        providerIds: listChannelProviders(),
        loadSenderAllowlist,
        loadSenderControlAllowlist,
        isSenderAllowed,
        isSenderControlAllowed,
        shouldLogDenied,
        logger,
        runtimeSecrets: new EnvRuntimeSecretProvider(),
      },
      ops: () => runtime.ops,
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
      runtimeSettings: () => settings,
    });
    const deliver = async (
      id: string,
      sender: string,
      content: string,
      replyTo?: string,
    ) =>
      inbound.onMessage(chatJid, {
        id,
        chat_jid: chatJid,
        provider: 'telegram',
        providerAccountId,
        sender,
        sender_name: sender,
        content,
        timestamp: nowIso(),
        is_from_me: false,
        is_bot_message: false,
        thread_id: threadId,
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
      });
    const replies = () =>
      channel.outbound.filter((message) =>
        message.text.includes('Thread reply.'),
      ).length;
    // A message the runtime has finished with moves its cursor past it.
    const settled = async (id: string) => {
      const state = JSON.parse(
        (await runtime.ops.getRouterState('last_agent_timestamp')) ?? '{}',
      ) as Record<string, string>;
      return Object.values(state).some(
        (cursor) => (JSON.parse(cursor) as { id?: string }).id === id,
      );
    };

    try {
      expect(await deliver('thread-root', 'alice', 'Andy start a plan')).toBe(
        'stored',
      );
      await waitFor(() => replies() === 1, 'reply to the thread root');
      expect(presented).toHaveLength(1);

      // No runner is alive: the other sender's follow-up starts nothing.
      expect(
        await deliver(
          'thread-other-sender',
          'bob',
          'yes, continue with that',
          'thread-root',
        ),
      ).toBe('stored');
      await waitFor(
        () => settled('thread-other-sender'),
        'the follow-up from the other sender handled',
      );
      expect(presented).toHaveLength(1);
      expect(replies()).toBe(1);

      expect(
        await deliver(
          'thread-allowed-sender',
          'alice',
          'and add a summary',
          'thread-root',
        ),
      ).toBe('stored');
      await waitFor(() => replies() === 2, 'reply to the allowed follow-up');
      expect(presented).toHaveLength(2);
      expect(presented[1]).toContain('and add a summary');

      // That runner is still alive. Follow-ups now land on the other worker,
      // which routes them to the running turn: the other sender's must not
      // reach it, and the allowed sender's does.
      workers[0]!.handle.stopAdmission();
      await workers[0]!.handle.admissionLoop?.done;
      workers.push(await startWorker('runtime-worker-thread-sender-b'));
      expect(
        await deliver(
          'thread-other-sender-while-alive',
          'bob',
          'also do the other thing',
          'thread-root',
        ),
      ).toBe('stored');
      await waitFor(
        () => settled('thread-other-sender-while-alive'),
        'the follow-up from the other sender handled while the runner is alive',
      );
      expect(
        await deliver(
          'thread-allowed-sender-while-alive',
          'alice',
          'and send it to me',
          'thread-root',
        ),
      ).toBe('stored');
      await waitFor(
        () => continued.length > 0,
        'the allowed follow-up delivered to the running turn',
      );
      expect(continued).toHaveLength(1);
      expect(continued[0]).toContain('and send it to me');
      expect(continued[0]).not.toContain('also do the other thing');
      expect(presented).toHaveLength(2);
      expect(replies()).toBe(2);
    } finally {
      releaseRunner();
      for (const worker of workers) {
        worker.handle.stopAdmission();
        worker.handle.stopRecovery();
        await worker.queue.shutdown(500);
        await worker.authority.shutdown();
      }
    }
  }, 60_000);
});

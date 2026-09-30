import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import { PostgresCanonicalMessageRepository } from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';
import { PostgresLiveTurnRepository } from '@core/adapters/storage/postgres/repositories/live-turn-repository.postgres.js';
import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import { parseAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import { type MessageLoopDeps } from '@core/runtime/message-loop.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import {
  buildLiveAdmissionProcessor,
  startLiveExecutionServices,
} from '@core/app/bootstrap/live-execution.js';
import { claimLiveTurnExecution } from '@core/application/live-turns/live-turn-lease-service.js';
import { LiveTurnAuthority } from '@core/runtime/live-turn-authority.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import { agentIdForFolder } from '@core/domain/agent/agent-folder-id.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('live admission work items (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let liveTurns: PostgresIntegrationRuntime['repositories']['liveTurns'];

  const base = {
    appId: 'default',
    agentSessionId: 'session-live-admission',
    conversationId: 'tg:live-admission',
    threadId: null,
    queueJid: 'tg:live-admission',
    messageId: 'message:tg:live-admission:msg-1',
    messageCursor: '2026-06-16T00:00:00.000Z::msg-1',
    idempotencyKey: 'telegram:delivery:msg-1',
  };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_admission',
    });
    liveTurns = runtime.repositories.liveTurns;
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('reads a taken message using the scope saved by real admission', async () => {
    const appId = 'app-real-admission-read';
    const admitted = await runtime.ops.storeMessageWithLiveAdmission(
      {
        id: 'msg-real-admission-read',
        chat_jid: 'tg:real-admission-read',
        provider: 'telegram',
        sender: 'user-real-admission-read',
        sender_name: 'Reader',
        content: 'read this saved message',
        timestamp: toIso(nowMs()),
        is_from_me: false,
        is_bot_message: false,
      },
      { appId },
    );
    expect(admitted?.outcome).toBe('enqueued');
    if (!admitted || admitted.outcome === 'overloaded')
      throw new Error('Expected a saved admission item');
    const { item } = admitted;
    const scope = {
      appId: item.appId,
      conversationId: item.conversationId,
      threadId: item.threadId,
      agentId: item.agentId,
      providerAccountId: item.providerAccountId,
    };
    expect(
      await liveTurns.takeInput({
        scope,
        consumedBy: 'turn:real-admission-read',
        limit: 1,
      }),
    ).toMatchObject([{ id: item.id, messageId: item.messageId }]);
    expect(
      (await runtime.ops.getMessagesByIds(scope, [item.messageId])).map(
        (message) => message.id,
      ),
    ).toEqual(['msg-real-admission-read']);
    expect(
      await runtime.ops.getMessagesByIds(
        { ...scope, appId: 'app-other-admission-read' },
        [item.messageId],
      ),
    ).toEqual([]);
    await liveTurns.enqueueLiveAdmissionWorkItem({
      ...base,
      id: 'item-foreign-conversation-read',
      appId,
      agentId: item.agentId,
      conversationId: 'tg:foreign-admission-read',
      providerAccountId: item.providerAccountId,
      queueJid: 'tg:foreign-admission-read',
      messageId: item.messageId,
      idempotencyKey: 'delivery:foreign-admission-read',
    });
    expect(
      await runtime.ops.getMessagesByIds(
        { ...scope, conversationId: 'tg:foreign-admission-read' },
        [item.messageId],
      ),
    ).toEqual([]);
  });

  it('gives each message to one turn in database receive order, including a late arrival', async () => {
    const queueJid = 'tg:consumption-crossing';
    const scope = {
      appId: 'app-consume-order',
      conversationId: queueJid,
      threadId: null,
      agentId: null,
      providerAccountId: null,
    };
    const enqueue = (id: string, messageCursor: string) =>
      liveTurns.enqueueLiveAdmissionWorkItem({
        ...base,
        appId: scope.appId,
        id,
        queueJid,
        conversationId: queueJid,
        messageId: `message:${id}`,
        messageCursor,
        idempotencyKey: `delivery:${id}`,
        now: '2000-01-01T00:00:00.000Z',
      });

    await enqueue('receive-first', '2030-01-01T00:00:00.000Z::first');
    await enqueue('receive-second', '1990-01-01T00:00:00.000Z::second');
    const first = await liveTurns.takeInput({
      scope,
      consumedBy: 'turn-1',
      limit: 10,
    });
    expect(first.map((item) => item.id)).toEqual([
      'receive-first',
      'receive-second',
    ]);
    expect(first[0]?.receiveOrder).toBeLessThan(first[1]!.receiveOrder!);
    expect(Date.parse(first[0]!.createdAt)).toBeGreaterThan(
      Date.parse('2000-01-01T00:00:00.000Z'),
    );

    await enqueue('receive-late', '1980-01-01T00:00:00.000Z::late');
    expect(
      await liveTurns.takeInput({ scope, consumedBy: 'turn-2', limit: 10 }),
    ).toMatchObject([{ id: 'receive-late', consumedBy: 'turn-2' }]);
    expect(
      await liveTurns.takeInput({ scope, consumedBy: 'turn-3', limit: 10 }),
    ).toEqual([]);

    expect(await liveTurns.releaseInput({ consumedBy: 'turn-1' })).toBe(2);
    expect(await liveTurns.releaseInput({ consumedBy: 'turn-1' })).toBe(0);
    expect(
      await liveTurns.takeInput({
        scope,
        consumedBy: 'turn-4',
        limit: 10,
      }),
    ).toMatchObject([{ id: 'receive-first' }, { id: 'receive-second' }]);
    expect(await liveTurns.releaseInput({ consumedBy: 'turn-2' })).toBe(1);
    expect(await liveTurns.consumeAll({ scope, consumedBy: 'history' })).toBe(
      1,
    );
    expect(
      await liveTurns.takeInput({
        scope,
        consumedBy: 'turn-5',
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('returns unanswered follow-ups with their turn after a failed reply', async () => {
    const scope = {
      appId: 'app-follow-up-retry',
      conversationId: 'tg:follow-up-retry',
      threadId: null,
      agentId: null,
      providerAccountId: null,
    };
    for (const id of ['initial', 'follow-up']) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        ...base,
        id: `item:${id}`,
        appId: scope.appId,
        conversationId: scope.conversationId,
        queueJid: scope.conversationId,
        messageId: `message:${id}`,
        idempotencyKey: `delivery:${id}`,
      });
    }
    expect(
      await liveTurns.takeInput({
        scope,
        consumedBy: 'turn:retry-run',
        limit: 1,
      }),
    ).toMatchObject([{ id: 'item:initial' }]);
    expect(
      await liveTurns.takeInput({
        scope,
        consumedBy: 'turn:retry-run/command:follow-up',
        limit: 1,
      }),
    ).toMatchObject([{ id: 'item:follow-up' }]);

    expect(
      await liveTurns.releaseInput({
        consumedBy: 'turn:retry-run',
        includeFollowUps: true,
      }),
    ).toBe(2);
    expect(
      (
        await liveTurns.takeInput({
          scope,
          consumedBy: 'turn:next-run',
          limit: 2,
        })
      ).map((item) => item.id),
    ).toEqual(['item:initial', 'item:follow-up']);
  });

  it('delivers non-default app and account input through a real turn, retrying only before reply', async () => {
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const appId = 'failure-boundary';
    const folder = 'failure_boundary';
    const chatJid = `app:${appId}:conversation`;
    const providerAccountId = `control:${appId}`;
    await runtime.control.ensureAppSession({
      appId,
      conversationId: 'conversation',
      chatJid,
      workspaceFolder: folder,
    });
    const agentId = agentIdForFolder(folder);
    const channel = createFakeChannelRuntime((jid) => jid === chatJid);
    let mode: 'silent' | 'delivered' | 'success' = 'silent';
    const presented: string[] = [];
    const app = createRuntimeApp({
      opsRepository: runtime.ops,
      ensureCredentialBinding: async () => ({ created: false }),
      runAgent: async (_group, input, _onProcess, onOutput) => {
        presented.push(input.prompt);
        if (mode === 'silent')
          return { status: 'error', error: 'runner failed' };
        await onOutput?.({
          status: 'success',
          result: 'The reply reached the user.',
        });
        return mode === 'delivered'
          ? { status: 'error', error: 'runner failed after output' }
          : { status: 'success', result: 'The reply reached the user.' };
      },
    });
    app.setChannelRuntime({
      ...channel.runtime,
      supportsStreaming: () => true,
    });
    await app.registerGroup(chatJid, {
      name: 'Failure boundary',
      folder,
      providerAccountId,
      trigger: 'Andy',
      added_at: toIso(nowMs()),
      requiresTrigger: false,
      conversationKind: 'dm',
      agentConfig: { model: 'opus' },
    });
    const save = async (id: string, content: string) => {
      const result = await runtime.ops.storeMessageWithLiveAdmission(
        {
          id,
          chat_jid: chatJid,
          provider: 'app',
          providerAccountId,
          sender: 'person',
          content,
          timestamp: toIso(nowMs()),
          is_from_me: false,
          is_bot_message: false,
        },
        { appId, agentId },
      );
      expect(result?.outcome).toBe('enqueued');
      if (!result || result.outcome === 'overloaded')
        throw new Error('Admission failed');
      return result.item;
    };
    const first = await save('msg:failure-before', 'before output');
    expect(first).toMatchObject({ appId, providerAccountId });
    expect(
      await app.processGroupMessages(first.queueJid, {
        existingRunId: 'run:failure-before',
      }),
    ).toBe(false);
    mode = 'success';
    expect(
      await app.processGroupMessages(first.queueJid, {
        existingRunId: 'run:retry',
      }),
    ).toBe(true);
    expect(presented).toHaveLength(2);
    expect(presented[0]).toContain('before output');
    expect(presented[1]).toContain('before output');
    expect(
      channel.streaming.some((entry) =>
        entry.text.includes('The reply reached the user.'),
      ),
    ).toBe(true);

    const second = await save('msg:failure-after', 'after output');
    mode = 'delivered';
    expect(
      await app.processGroupMessages(second.queueJid, {
        existingRunId: 'run:failure-after',
      }),
    ).toBe(true);
    expect(
      await liveTurns.hasDeliveredOutputForRun({ runId: 'run:failure-after' }),
    ).toBe(true);
    mode = 'success';
    expect(
      await app.processGroupMessages(second.queueJid, {
        existingRunId: 'run:next',
      }),
    ).toBe(true);
    expect(presented).toHaveLength(3);
    expect(presented[2]).toContain('after output');
    const table = `${quotePostgresIdentifier(runtime.schemaName)}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const { rows } = await runtime.service.pool.query<{
      id: string;
      consumed_by: string | null;
    }>(`SELECT id, consumed_by FROM ${table} WHERE id = ANY($1)`, [
      [first.id, second.id],
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: first.id, consumed_by: 'turn:run:retry' },
        { id: second.id, consumed_by: 'turn:run:failure-after' },
      ]),
    );

    const unreadable = await liveTurns.enqueueLiveAdmissionWorkItem({
      ...base,
      id: 'item:unreadable-turn',
      appId,
      agentId,
      conversationId: chatJid,
      providerAccountId,
      queueJid: first.queueJid,
      messageId: 'message:unreadable-turn',
      idempotencyKey: 'delivery:unreadable-turn',
    });
    expect(unreadable.outcome).toBe('enqueued');
    await expect(
      app.processGroupMessages(first.queueJid, {
        existingRunId: 'run:unreadable-turn',
      }),
    ).rejects.toThrow('Taken input has no scoped message row');
    expect(presented).toHaveLength(3);
    expect(
      await liveTurns.takeInput({
        scope: unreadable.item,
        consumedBy: 'turn:after-unreadable',
        limit: 1,
      }),
    ).toMatchObject([{ id: unreadable.item.id }]);
  });

  it('delivers a normal channel JID in a non-default app to the turn', async () => {
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const appId = 'channel-app-scope';
    const chatJid = 'tg:channel-app-scope';
    const folder = 'channel_app_scope';
    // Provider accounts are stored under the default app; this is the Telegram
    // account a message without an explicit account resolves to.
    const providerAccountId = 'channel-providerAccount:default:telegram';
    await runtime.control.ensureAppSession({
      appId,
      conversationId: 'channel-app-scope',
      chatJid,
      workspaceFolder: folder,
    });
    const presented: string[] = [];
    const channel = createFakeChannelRuntime((jid) => jid === chatJid);
    const app = createRuntimeApp({
      opsRepository: runtime.ops,
      ensureCredentialBinding: async () => ({ created: false }),
      runAgent: async (_group, input, _onProcess, onOutput) => {
        presented.push(input.prompt);
        await onOutput?.({ status: 'success', result: 'I saw your message.' });
        return { status: 'success', result: 'I saw your message.' };
      },
    });
    app.setChannelRuntime(channel.runtime);
    await app.registerGroup(chatJid, {
      name: 'Channel app scope',
      folder,
      providerAccountId,
      trigger: 'Andy',
      added_at: toIso(nowMs()),
      requiresTrigger: false,
      conversationKind: 'dm',
      agentConfig: { model: 'opus' },
    });
    const admitted = await runtime.ops.storeMessageWithLiveAdmission(
      {
        id: 'message:channel-app-scope',
        chat_jid: chatJid,
        provider: 'telegram',
        sender: 'person',
        content: 'message in another app',
        timestamp: toIso(nowMs()),
        is_from_me: false,
        is_bot_message: false,
      },
      { appId, agentId: agentIdForFolder(folder), providerAccountId },
    );
    expect(admitted?.outcome).toBe('enqueued');
    if (!admitted || admitted.outcome === 'overloaded')
      throw new Error('Admission failed');
    const processorInput = {
      appId,
      inputRepository: liveTurns,
      liveTurnAuthority: undefined,
      app,
      opsRepository: runtime.ops,
      executionAdapter: { id: 'anthropic:claude-agent-sdk' as const },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: () => undefined,
      warn: () => undefined,
    };
    expect(
      await buildLiveAdmissionProcessor(processorInput)(admitted.item.queueJid),
    ).toBe(true);
    expect(presented).toHaveLength(1);
    expect(presented[0]).toContain('message in another app');
    expect(
      channel.outbound.some((message) =>
        message.text.includes('I saw your message.'),
      ),
    ).toBe(true);
    expect(
      await liveTurns.takeInput({
        scope: admitted.item,
        consumedBy: 'turn:channel-app-scope-next',
        limit: 1,
      }),
    ).toEqual([]);
    await app.queue.shutdown(500);
  });

  it('delivers a follow-up after a replied worker crashes without repeating answered input', async () => {
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const appId = 'restart-boundary';
    const folder = 'restart_boundary';
    const providerAccountId = `control:${appId}`;
    const queue = new GroupQueue({
      maxMessageRuns: 3,
      maxJobRuns: 1,
      maxRetries: 0,
      baseRetryMs: 25,
    });
    const delivered: string[] = [];
    const channel = createFakeChannelRuntime((jid) =>
      jid.startsWith(`app:${appId}:`),
    );
    const makeApp = (runtimeQueue?: GroupQueue) => {
      const runtimeApp = createRuntimeApp({
        queue: runtimeQueue,
        opsRepository: runtime.ops,
        ensureCredentialBinding: async () => ({ created: false }),
        runAgent: async (_group, input, _onProcess, onOutput) => {
          delivered.push(input.prompt);
          const output = {
            status: 'success' as const,
            result: 'The answer was delivered.',
          };
          await onOutput?.(output);
          return output;
        },
      });
      runtimeApp.setChannelRuntime({
        ...channel.runtime,
        supportsStreaming: () => true,
      });
      return runtimeApp;
    };
    const beforeApp = makeApp();
    const app = makeApp(queue);
    const workerAfter = 'restart-worker-after';
    await runtime.repositories.workerCoordination.registerWorker({
      id: workerAfter,
      bootNonce: workerAfter,
    });
    const leaseDeps = {
      liveTurns,
      coordination: runtime.repositories.workerCoordination,
      workerInstanceId: workerAfter,
    };
    const authority = new LiveTurnAuthority({
      leaseDeps,
      slotCapacity: () => 2,
    });
    queue.setLiveTurnRunnerRegistrar((jid, hooks, routing) =>
      authority.registerLocalRunner(jid, hooks, routing),
    );
    const processor = buildLiveAdmissionProcessor({
      inputRepository: liveTurns,
      liveTurnAuthority: authority,
      app,
      opsRepository: runtime.ops,
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: (jid) => {
        queue.enqueueMessageCheck(jid);
      },
      warn: () => undefined,
    });
    queue.setProcessMessagesFn((jid, context) => processor(jid, context));
    const cases = [
      {
        jid: `app:${appId}:unanswered`,
        content: 'unanswered request',
        answered: false,
      },
      {
        jid: `app:${appId}:answered`,
        content: 'answered request',
        answered: true,
      },
      {
        jid: `app:${appId}:answered-follow-up`,
        content: 'answered before follow-up',
        answered: true,
        followUp: 'follow-up after reply',
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const workerBefore = `restart-worker-before-${index}`;
      await runtime.repositories.workerCoordination.registerWorker({
        id: workerBefore,
        bootNonce: workerBefore,
      });
      await runtime.control.ensureAppSession({
        appId,
        conversationId: scenario.jid.slice(`app:${appId}:`.length),
        chatJid: scenario.jid,
        workspaceFolder: folder,
      });
      await beforeApp.registerGroup(scenario.jid, {
        name: 'Restart boundary',
        folder,
        providerAccountId,
        trigger: 'Andy',
        added_at: toIso(nowMs()),
        requiresTrigger: false,
        conversationKind: 'dm',
        agentConfig: { model: 'opus' },
      });
      const context = await runtime.ops.getAgentTurnContext({
        agentFolder: folder,
        executionProviderId: 'anthropic:claude-agent-sdk',
        conversationJid: scenario.jid,
        providerAccountId,
        threadId: null,
        hydrateMemory: false,
      });
      expect(context?.agentSessionId).toBeTruthy();
      const runId = await runtime.ops.createSessionAgentRun({
        agentSessionId: context!.agentSessionId,
        executionProviderId: 'anthropic:claude-agent-sdk',
        cause: 'message',
      });
      expect(runId).toBeTruthy();
      const saved = await runtime.ops.storeMessageWithLiveAdmission(
        {
          id: `message:${scenario.jid}`,
          chat_jid: scenario.jid,
          provider: 'app',
          providerAccountId,
          sender: 'person',
          content: scenario.content,
          timestamp: toIso(nowMs()),
          is_from_me: false,
          is_bot_message: false,
        },
        { appId, agentId: agentIdForFolder(folder) },
      );
      expect(saved?.outcome).toBe('enqueued');
      if (!saved || saved.outcome === 'overloaded' || !runId)
        throw new Error('Restart setup failed');
      const claimed = await claimLiveTurnExecution({
        deps: { ...leaseDeps, workerInstanceId: workerBefore },
        turnId: `turn:${scenario.jid}`,
        scope: {
          appId,
          agentSessionId: context!.agentSessionId,
          conversationId: scenario.jid,
          threadId: null,
        },
        runId,
        pendingMessage: {
          kind: 'message_cursor',
          queueJid: saved.item.queueJid,
          cursorBefore: '',
        },
        slotCapacity: 2,
        leaseTtlMs: 1_000,
        now: toIso(nowMs() - 60_000),
      });
      expect(claimed.outcome).toBe('claimed');
      if (scenario.answered) {
        expect(
          await beforeApp.processGroupMessages(saved.item.queueJid, {
            existingRunId: runId,
          }),
        ).toBe(true);
        expect(await liveTurns.hasDeliveredOutputForRun({ runId })).toBe(true);
        if ('followUp' in scenario && scenario.followUp) {
          const followUp = await runtime.ops.storeMessageWithLiveAdmission(
            {
              id: `message:follow-up:${scenario.jid}`,
              chat_jid: scenario.jid,
              provider: 'app',
              providerAccountId,
              sender: 'person',
              content: scenario.followUp,
              timestamp: toIso(nowMs()),
              is_from_me: false,
              is_bot_message: false,
            },
            { appId, agentId: agentIdForFolder(folder) },
          );
          expect(followUp?.outcome).toBe('enqueued');
          if (!followUp || followUp.outcome === 'overloaded')
            throw new Error('Follow-up admission failed');
          const commandId = `command:${scenario.jid}`;
          expect(
            await liveTurns.takeInput({
              scope: followUp.item,
              consumedBy: `turn:${runId}/command:${commandId}`,
              limit: 1,
            }),
          ).toMatchObject([{ id: followUp.item.id }]);
          expect(
            await liveTurns.appendLiveTurnCommand({
              id: commandId,
              liveTurnId: `turn:${scenario.jid}`,
              commandType: 'continuation',
              idempotencyKey: followUp.item.id,
              payload: { text: scenario.followUp },
            }),
          ).toMatchObject({ outcome: 'appended' });
        }
      } else {
        const taken = await liveTurns.takeInput({
          scope: saved.item,
          consumedBy: `turn:${runId}`,
          limit: 1,
        });
        expect(taken.map((item) => item.id)).toEqual([saved.item.id]);
      }
    }
    await app.loadState();
    for (const scenario of cases) {
      await app.registerGroup(scenario.jid, {
        name: 'Restart boundary',
        folder,
        providerAccountId,
        trigger: 'Andy',
        added_at: toIso(nowMs()),
        requiresTrigger: false,
        conversationKind: 'dm',
        agentConfig: { model: 'opus' },
      });
    }
    const messageLoopDeps: MessageLoopDeps = {
      appId,
      inputRepository: liveTurns,
      getConversationRoutes: app.getConversationRoutes,
      getOrRecoverCursor: app.getOrRecoverCursor,
      setAgentCursor: app.setAgentCursor,
      saveState: app.saveState,
      hasChannel: channel.runtime.hasChannel,
      setTyping: channel.runtime.setTyping,
      sendProgressUpdate: channel.runtime.sendProgressUpdate,
      queue,
      opsRepository: runtime.ops,
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const handle = startLiveExecutionServices({
        appId,
        app,
        liveTurnAuthority: authority,
        liveTurnLeaseDeps: leaseDeps,
        messageLoopDeps,
        recoveryCoordinator: undefined,
        isEligibleToRecoverLiveTurn: () => true,
        alertNoEligibleLiveTurnRecoverer: undefined,
        startLiveAdmissionWorkLoop: () => ({
          stop: async () => undefined,
          trigger: () => undefined,
          done: new Promise<void>(() => undefined),
        }),
        registerActiveAdmissionLoop: () => undefined,
        registerActiveRecoveryLoop: () => undefined,
        onPollingCrash: (error) => {
          throw error;
        },
        info: () => undefined,
        warn: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.waitFor(
        () =>
          expect(delivered).toContainEqual(
            expect.stringContaining('follow-up after reply'),
          ),
        { timeout: 10_000 },
      );
      expect(delivered[0]).toContain('answered request');
      expect(delivered).toContainEqual(
        expect.stringContaining('unanswered request'),
      );
      expect(delivered).toContainEqual(
        expect.stringContaining('follow-up after reply'),
      );
      expect(
        delivered.filter((prompt) =>
          prompt
            .split('<current_message')
            .at(-1)
            ?.includes('answered before follow-up'),
        ),
      ).toHaveLength(1);
      expect(
        channel.streaming.some((entry) =>
          entry.text.includes('The answer was delivered.'),
        ),
      ).toBe(true);
      handle.stopAdmission();
      handle.stopRecovery();
    } finally {
      vi.useRealTimers();
      await queue.shutdown(500);
      await beforeApp.queue.shutdown(500);
    }
  }, 60_000);

  it.each([
    {
      axis: 'application',
      first: { appId: 'app-scope-a' },
      second: { appId: 'app-scope-b' },
    },
    {
      axis: 'account',
      first: { providerAccountId: 'account-a' },
      second: { providerAccountId: 'account-b' },
    },
    {
      axis: 'thread',
      first: { threadId: 'thread-a' },
      second: { threadId: 'thread-b' },
    },
    {
      axis: 'agent',
      first: { agentId: 'agent:scope-a' },
      second: { agentId: 'agent:scope-b' },
    },
  ])(
    'keeps consumption inside its $axis scope',
    async ({ axis, first, second }) => {
      const common = {
        appId: `app-consume-scope-${axis}`,
        conversationId: `tg:consume-scope-${axis}`,
        threadId: null,
        agentId: null,
        providerAccountId: null,
      };
      const firstScope = { ...common, ...first };
      const secondScope = { ...common, ...second };
      for (const [name, scope] of [
        ['first', firstScope],
        ['second', secondScope],
      ] as const) {
        for (const index of [1, 2]) {
          const id = `${axis}-${name}-${index}`;
          await liveTurns.enqueueLiveAdmissionWorkItem({
            ...base,
            ...scope,
            id,
            queueJid: scope.conversationId,
            messageId: `message:${id}`,
            idempotencyKey: `delivery:${id}`,
          });
        }
      }

      expect(
        (
          await liveTurns.takeInput({
            scope: firstScope,
            consumedBy: `${axis}-first-turn`,
            limit: 1,
          })
        ).map((item) => item.id),
      ).toEqual([`${axis}-first-1`]);
      expect(
        await liveTurns.consumeAll({
          scope: firstScope,
          consumedBy: `${axis}-first-history`,
        }),
      ).toBe(1);
      expect(
        (
          await liveTurns.takeInput({
            scope: secondScope,
            consumedBy: `${axis}-second-turn`,
            limit: 10,
          })
        ).map((item) => item.id),
      ).toEqual([`${axis}-second-1`, `${axis}-second-2`]);
    },
  );

  it('gives overlapping consumers disjoint input in receive order', async () => {
    const secondService = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL!,
      runtime.schemaName,
    );
    const second = new PostgresLiveTurnRepository(secondService.db);
    const scope = {
      appId: 'app-consume-concurrent',
      conversationId: 'tg:consume-concurrent',
      threadId: null,
      agentId: null,
      providerAccountId: null,
    };
    try {
      for (let index = 0; index < 4; index++) {
        await liveTurns.enqueueLiveAdmissionWorkItem({
          ...base,
          ...scope,
          id: `concurrent-${index}`,
          queueJid: scope.conversationId,
          messageId: `message-concurrent-${index}`,
          idempotencyKey: `delivery-concurrent-${index}`,
        });
      }
      const [first, other] = await Promise.all([
        liveTurns.takeInput({ scope, consumedBy: 'concurrent-a', limit: 2 }),
        second.takeInput({ scope, consumedBy: 'concurrent-b', limit: 2 }),
      ]);
      const ids = [...first, ...other].map((item) => item.id);
      expect(new Set(ids).size).toBe(4);
      expect(ids.sort()).toEqual([
        'concurrent-0',
        'concurrent-1',
        'concurrent-2',
        'concurrent-3',
      ]);
      for (const batch of [first, other]) {
        expect(batch.map((item) => item.receiveOrder)).toEqual(
          [...batch.map((item) => item.receiveOrder)].sort((a, b) => a! - b!),
        );
      }
    } finally {
      await secondService.close();
    }
  });

  it('deduplicates provider delivery by idempotency key', async () => {
    const first = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-1',
      ...base,
      triggerDecision: { requiresTrigger: false },
      now: toIso(nowMs() - 10_000),
    });
    expect(first.outcome).toBe('enqueued');
    expect(first.item).toMatchObject({
      id: 'admission-1',
      state: 'queued',
      sourceKind: 'message',
      triggerDecision: { requiresTrigger: false },
    });

    const replay = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-duplicate',
      ...base,
    });
    expect(replay.outcome).toBe('replayed');
    expect(replay.item.id).toBe('admission-1');
  });

  it('deduplicates provider delivery by deterministic work item id', async () => {
    const first = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-id-replay',
      ...base,
      appId: 'app-id-replay',
      messageId: 'message:tg:live-admission:id-replay',
      messageCursor: '2026-06-16T00:00:00.500Z::id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:root',
      now: toIso(nowMs() - 9_500),
    });
    expect(first.outcome).toBe('enqueued');

    const replay = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-id-replay',
      ...base,
      appId: 'app-id-replay',
      messageId: 'message:tg:live-admission:id-replay',
      messageCursor: '2026-06-16T00:00:00.500Z::id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:thread',
    });

    expect(replay.outcome).toBe('replayed');
    expect(replay.item).toMatchObject({
      id: 'admission-id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:root',
    });
  });

  it('atomically caps concurrent active admissions per app', async () => {
    const cap = 3;
    const appId = 'app-cap-flood';
    const cappedLiveTurns = new PostgresLiveTurnRepository(
      runtime.service.db,
      undefined,
      cap,
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        cappedLiveTurns.enqueueLiveAdmissionWorkItem({
          id: `admission-cap-flood-${index}`,
          ...base,
          appId,
          messageId: `message:cap-flood:${index}`,
          messageCursor: `2026-06-16T00:00:00.000Z::cap-flood-${index}`,
          idempotencyKey: `telegram:delivery:cap-flood-${index}`,
        }),
      ),
    );

    expect(
      results.filter((result) => result.outcome === 'enqueued'),
    ).toHaveLength(cap);
    expect(
      results.filter((result) => result.outcome === 'overloaded'),
    ).toHaveLength(12 - cap);

    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const { rows } = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${tableName}
       WHERE app_id = $1
         AND state IN ('queued', 'claimed', 'deferred')`,
      [appId],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(cap);
  });

  it('replays duplicates at capacity and frees capacity only for terminal rows', async () => {
    const cap = 2;
    const appId = 'app-cap-replay';
    const cappedLiveTurns = new PostgresLiveTurnRepository(
      runtime.service.db,
      undefined,
      cap,
    );
    const inputs = [0, 1].map((index) => ({
      id: `admission-cap-replay-${index}`,
      ...base,
      appId,
      messageId: `message:cap-replay:${index}`,
      messageCursor: `2026-06-16T00:00:00.000Z::cap-replay-${index}`,
      idempotencyKey: `telegram:delivery:cap-replay-${index}`,
    }));
    await Promise.all(
      inputs.map((input) =>
        cappedLiveTurns.enqueueLiveAdmissionWorkItem(input),
      ),
    );

    const replay = await cappedLiveTurns.enqueueLiveAdmissionWorkItem({
      ...inputs[0],
      id: 'admission-cap-replay-duplicate-id',
    });
    expect(replay).toMatchObject({
      outcome: 'replayed',
      item: { id: inputs[0].id },
    });
    await expect(
      cappedLiveTurns.enqueueLiveAdmissionWorkItem({
        ...inputs[0],
        id: 'admission-cap-replay-overloaded',
        messageId: 'message:cap-replay:overloaded',
        messageCursor: '2026-06-16T00:00:00.000Z::cap-replay-overloaded',
        idempotencyKey: 'telegram:delivery:cap-replay-overloaded',
      }),
    ).resolves.toEqual({ outcome: 'overloaded' });

    const [claimed] = await cappedLiveTurns.claimLiveAdmissionWorkItems({
      appId,
      workerInstanceId: 'worker-cap-replay',
      claimToken: 'claim-token-cap-replay',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    await cappedLiveTurns.settleLiveAdmissionWorkItem({
      id: claimed.id,
      workerInstanceId: 'worker-cap-replay',
      claimToken: 'claim-token-cap-replay',
      state: 'completed',
    });
    await expect(
      cappedLiveTurns.enqueueLiveAdmissionWorkItem({
        ...inputs[0],
        id: 'admission-cap-replay-after-terminal',
        messageId: 'message:cap-replay:after-terminal',
        messageCursor: '2026-06-16T00:00:00.000Z::cap-replay-after-terminal',
        idempotencyKey: 'telegram:delivery:cap-replay-after-terminal',
      }),
    ).resolves.toMatchObject({ outcome: 'enqueued' });
  });

  it('keeps unconsumed items during the terminal retention sweep', async () => {
    const appId = 'app-terminal-retention';
    const oldAt = '2026-07-03T00:00:00.000Z';
    const recentAt = '2026-07-05T00:00:00.000Z';
    const cutoff = '2026-07-04T00:00:00.000Z';
    const rows = [
      ['retention-old-completed', 'completed', oldAt, oldAt],
      ['retention-old-failed', 'failed', oldAt, oldAt],
      ['retention-old-canceled', 'canceled', oldAt, null],
      ['retention-old-queued', 'queued', oldAt, null],
      ['retention-old-claimed', 'claimed', oldAt, null],
      ['retention-old-deferred', 'deferred', oldAt, null],
      ['retention-recent-completed', 'completed', recentAt, recentAt],
      ['retention-recent-failed', 'failed', recentAt, recentAt],
      ['retention-recent-canceled', 'canceled', recentAt, recentAt],
    ] as const;
    await Promise.all(
      rows.map(([id], index) =>
        liveTurns.enqueueLiveAdmissionWorkItem({
          id,
          ...base,
          appId,
          messageId: `message:retention:${index}`,
          messageCursor: `2026-08-03T00:00:00.000Z::retention-${index}`,
          idempotencyKey: `telegram:delivery:retention-${index}`,
        }),
      ),
    );
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await Promise.all(
      rows.map(([id, state, updatedAt, endedAt]) =>
        runtime.service.pool.query(
          `UPDATE ${tableName}
           SET state = $2, updated_at = $3, ended_at = $4,
               consumed_at = CASE WHEN $2 IN ('completed', 'failed') THEN $3::timestamptz ELSE NULL END,
               consumed_by = CASE WHEN $2 IN ('completed', 'failed') THEN 'prior-turn' ELSE NULL END
           WHERE id = $1`,
          [id, state, updatedAt, endedAt],
        ),
      ),
    );

    await expect(
      liveTurns.deleteExpiredTerminalLiveAdmissionWorkItems(cutoff),
    ).resolves.toEqual({ deleted: 2, more: false });

    const remaining = await runtime.service.pool.query<{ id: string }>(
      `SELECT id FROM ${tableName} WHERE app_id = $1 ORDER BY id`,
      [appId],
    );
    expect(remaining.rows.map(({ id }) => id)).toEqual([
      'retention-old-canceled',
      'retention-old-claimed',
      'retention-old-deferred',
      'retention-old-queued',
      'retention-recent-canceled',
      'retention-recent-completed',
      'retention-recent-failed',
    ]);
  });

  it('keeps an expired item released while the retention sweep waits for its row', async () => {
    const id = 'retention-concurrent-release';
    const oldAt = '2026-07-03T00:00:00.000Z';
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await liveTurns.enqueueLiveAdmissionWorkItem({
      ...base,
      id,
      appId: 'app-retention-concurrent-release',
      messageId: `message:${id}`,
      idempotencyKey: `delivery:${id}`,
    });
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed', consumed_at = $2, consumed_by = 'prior-turn',
           updated_at = $2, ended_at = $2
       WHERE id = $1`,
      [id, oldAt],
    );

    const releasingClient = await runtime.service.pool.connect();
    let sweep:
      | ReturnType<typeof liveTurns.deleteExpiredTerminalLiveAdmissionWorkItems>
      | undefined;
    try {
      await releasingClient.query('BEGIN');
      const {
        rows: [{ pid }],
      } = await releasingClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      await releasingClient.query(
        `UPDATE ${tableName}
         SET consumed_at = NULL, consumed_by = NULL
         WHERE id = $1`,
        [id],
      );
      sweep = liveTurns.deleteExpiredTerminalLiveAdmissionWorkItems(
        '2026-07-04T00:00:00.000Z',
      );
      const deadline = Date.now() + 10_000;
      while (true) {
        const {
          rows: [{ blocked }],
        } = await runtime.service.pool.query<{
          blocked: boolean;
        }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid)) AND pid <> $1
           ) AS blocked`,
          [pid],
        );
        if (blocked) break;
        if (Date.now() > deadline) {
          throw new Error('Retention sweep did not reach the held row.');
        }
      }
    } finally {
      await releasingClient.query('COMMIT');
      releasingClient.release();
    }

    await expect(sweep).resolves.toEqual({ deleted: 0, more: false });
    const { rows } = await runtime.service.pool.query<{
      consumed_at: string | null;
    }>(`SELECT consumed_at FROM ${tableName} WHERE id = $1`, [id]);
    expect(rows).toEqual([{ consumed_at: null }]);
  });

  it('persists an overloaded canonical message without a work row or wakeup', async () => {
    const notifyLiveAdmissionWorkItem = vi.fn(async () => undefined);
    const messages = new CanonicalMessageOpsService(
      new PostgresCanonicalMessageRepository(runtime.service.db, 1),
      { notifyLiveAdmissionWorkItem },
    );
    const appId = 'app-overloaded-canonical-message';
    const makeMessage = (index: number) => ({
      id: `msg-overloaded-${index}`,
      chat_jid: 'tg:overloaded-canonical-message',
      provider: 'telegram',
      sender: 'user-overloaded',
      sender_name: 'Overloaded User',
      content: `canonical message ${index}`,
      timestamp: `2026-06-16T00:00:0${index}.000Z`,
      is_from_me: false,
      is_bot_message: false,
    });

    await expect(
      messages.storeMessageWithLiveAdmission(makeMessage(1), { appId }),
    ).resolves.toMatchObject({ outcome: 'enqueued' });
    await expect(
      messages.storeMessageWithLiveAdmission(makeMessage(2), { appId }),
    ).resolves.toEqual({ outcome: 'overloaded' });
    expect(notifyLiveAdmissionWorkItem).toHaveBeenCalledTimes(1);

    const workItemsTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const messagesTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('messages')}`;
    const [workItems, canonicalMessages] = await Promise.all([
      runtime.service.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${workItemsTable}
         WHERE app_id = $1`,
        [appId],
      ),
      runtime.service.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${messagesTable}
         WHERE external_message_id = ANY($1::text[])`,
        [['msg-overloaded-1', 'msg-overloaded-2']],
      ),
    ]);
    expect(Number(workItems.rows[0]?.count ?? 0)).toBe(1);
    expect(Number(canonicalMessages.rows[0]?.count ?? 0)).toBe(2);
  });

  it('claims due rows in durable FIFO order without prompt text payloads', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-2',
      ...base,
      messageId: 'message:tg:live-admission:msg-2',
      messageCursor: '2026-06-16T00:00:01.000Z::msg-2',
      idempotencyKey: 'telegram:delivery:msg-2',
      now: toIso(nowMs() - 9_000),
    });

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-1',
      claimToken: 'claim-token-1',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).toEqual([
      'admission-1',
      'admission-2',
    ]);
    expect(claimed[0]).toMatchObject({
      state: 'claimed',
      claimWorkerInstanceId: 'worker-1',
      claimToken: 'claim-token-1',
      fencingVersion: 1,
      retryCount: 1,
      failureCount: 0,
    });
    expect(JSON.stringify(claimed)).not.toContain('hello');
    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-2',
        claimToken: 'claim-token-1',
        workerInstanceId: 'worker-1',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('defers capacity-limited claims and reclaims them only when due', async () => {
    const deferred = await liveTurns.deferLiveAdmissionWorkItem({
      id: 'admission-1',
      claimToken: 'claim-token-1',
      workerInstanceId: 'worker-1',
      reason: 'queued_capacity',
      deferUntil: toIso(nowMs() + 60_000),
    });
    expect(deferred).toBe(true);

    await expect(
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-2',
        claimToken: 'claim-token-2',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const reclaimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-2',
      claimToken: 'claim-token-2',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
      now: toIso(nowMs() + 120_000),
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      id: 'admission-1',
      state: 'claimed',
      claimWorkerInstanceId: 'worker-2',
      claimToken: 'claim-token-2',
      deferredReason: null,
      fencingVersion: 2,
      retryCount: 2,
      failureCount: 0,
    });
  });

  it('counts real processing failures separately from claim attempts', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-failure-count',
      ...base,
      messageId: 'message:tg:live-admission:failure-count',
      messageCursor: '2026-06-16T00:00:01.500Z::failure-count',
      idempotencyKey: 'telegram:delivery:failure-count',
      now: toIso(nowMs() - 8_000),
    });
    const [claimed] = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-failure-count',
      claimToken: 'claim-token-failure-count',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    expect(claimed).toMatchObject({
      id: 'admission-failure-count',
      retryCount: 1,
      failureCount: 0,
    });

    await expect(
      liveTurns.deferLiveAdmissionWorkItem({
        id: 'admission-failure-count',
        claimToken: 'claim-token-failure-count',
        workerInstanceId: 'worker-failure-count',
        reason: 'listener_degraded',
        deferUntil: toIso(nowMs() - 1_000),
        countFailure: true,
      }),
    ).resolves.toBe(true);

    const [reclaimed] = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-failure-count-reclaim',
      claimToken: 'claim-token-failure-count-reclaim',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    expect(reclaimed).toMatchObject({
      id: 'admission-failure-count',
      retryCount: 2,
      failureCount: 1,
    });

    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-failure-count',
        claimToken: 'claim-token-failure-count-reclaim',
        workerInstanceId: 'worker-failure-count-reclaim',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('claims only work items for the requested app scope', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-other-app',
      ...base,
      appId: 'app-other',
      messageId: 'message:tg:live-admission:other-app',
      messageCursor: '2026-06-16T00:00:02.000Z::other-app',
      idempotencyKey: 'telegram:delivery:other-app',
      now: toIso(nowMs() - 7_000),
    });

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-app-scope',
      claimToken: 'claim-token-app-scope',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).not.toContain('admission-other-app');
  });

  it('renews a claim before another worker can reclaim an expired batch row', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-renew-expiry',
      ...base,
      messageId: 'message:tg:live-admission:renew-expiry',
      messageCursor: '2026-06-16T00:00:02.500Z::renew-expiry',
      idempotencyKey: 'telegram:delivery:renew-expiry',
      now: toIso(nowMs() - 6_000),
    });
    const first = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-renew-a',
      claimToken: 'claim-token-renew-a',
      claimExpiresAt: '2026-06-16T00:00:03.000Z',
      limit: 1,
      now: '2026-06-16T00:00:02.000Z',
    });
    expect(first.map((item) => item.id)).toEqual(['admission-renew-expiry']);

    await expect(
      liveTurns.renewLiveAdmissionWorkItemClaim({
        id: 'admission-renew-expiry',
        workerInstanceId: 'worker-renew-a',
        claimToken: 'claim-token-renew-a',
        claimExpiresAt: '2026-06-16T00:01:00.000Z',
        now: '2026-06-16T00:00:02.500Z',
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-renew-b',
        claimToken: 'claim-token-renew-b',
        claimExpiresAt: '2026-06-16T00:02:00.000Z',
        limit: 1,
        now: '2026-06-16T00:00:04.000Z',
      }),
    ).resolves.toEqual([]);

    await liveTurns.settleLiveAdmissionWorkItem({
      id: 'admission-renew-expiry',
      workerInstanceId: 'worker-renew-a',
      claimToken: 'claim-token-renew-a',
      state: 'completed',
    });
  });

  it('rejects stale settlement and accepts the active claim fence', async () => {
    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-1',
        claimToken: 'claim-token-1',
        workerInstanceId: 'worker-1',
        state: 'completed',
      }),
    ).resolves.toBe(false);

    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-1',
        claimToken: 'claim-token-2',
        workerInstanceId: 'worker-2',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('claims concurrent due rows without duplicate ownership', async () => {
    const createdAt = toIso(nowMs() - 8_000);
    for (const suffix of ['a', 'b']) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id: `admission-concurrent-${suffix}`,
        ...base,
        messageId: `message:tg:live-admission:concurrent-${suffix}`,
        messageCursor: `2026-06-16T00:00:03.000Z::concurrent-${suffix}`,
        idempotencyKey: `telegram:delivery:concurrent-${suffix}`,
        now: createdAt,
      });
    }

    const [workerA, workerB] = await Promise.all([
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-concurrent-a',
        claimToken: 'claim-token-concurrent-a',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-concurrent-b',
        claimToken: 'claim-token-concurrent-b',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
    ]);

    const claimed = [...workerA, ...workerB];
    expect(claimed.map((item) => item.id).sort()).toEqual([
      'admission-concurrent-a',
      'admission-concurrent-b',
    ]);
    expect(new Set(claimed.map((item) => item.id)).size).toBe(2);
    for (const item of claimed) {
      await expect(
        liveTurns.settleLiveAdmissionWorkItem({
          id: item.id,
          claimToken: item.claimToken ?? '',
          workerInstanceId: item.claimWorkerInstanceId ?? '',
          state: 'completed',
        }),
      ).resolves.toBe(true);
    }
  });

  it('does not let branch preselection locks hide older concurrent candidates', async () => {
    const createdAt = '2026-06-16T00:00:10.000Z';
    const dueAt = '2000-01-01T00:00:00.000Z';
    const now = '2026-06-16T00:01:00.000Z';
    const ids = [
      'admission-lock-queued',
      'admission-lock-due-1',
      'admission-lock-due-2',
    ];
    for (const [index, id] of ids.entries()) {
      await expect(
        liveTurns.enqueueLiveAdmissionWorkItem({
          id,
          ...base,
          messageId: `message:tg:live-admission:${id}`,
          messageCursor: `2026-06-16T00:00:10.000Z::${id}`,
          idempotencyKey: `telegram:delivery:${id}`,
          now: toIso(Date.parse(createdAt) + index),
        }),
      ).resolves.toMatchObject({ outcome: 'enqueued', item: { id } });
    }
    await runtime.service.pool.query(
      `UPDATE ${quotePostgresIdentifier(
        runtime.schemaName,
      )}.${quotePostgresIdentifier('live_admission_work_items')}
       SET state = 'deferred',
           defer_until = $1,
           deferred_reason = 'retry',
           updated_at = $2
       WHERE id IN ($3, $4)`,
      [dueAt, now, 'admission-lock-due-1', 'admission-lock-due-2'],
    );

    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const held = await runtime.service.pool.connect();
    try {
      await held.query('BEGIN');
      const first = await held.query<{ id: string }>(
        `WITH queued AS (
           SELECT id, created_at
           FROM ${tableName}
           WHERE app_id = $3
             AND state = 'queued'
           ORDER BY created_at ASC, id ASC
           LIMIT $2
         ),
         due_deferred AS (
           SELECT id, created_at
           FROM ${tableName}
           WHERE app_id = $3
             AND state = 'deferred'
             AND defer_until <= $1
           ORDER BY defer_until ASC, created_at ASC, id ASC
           LIMIT $2
         ),
         candidates AS (
           SELECT id, created_at FROM queued
           UNION ALL
           SELECT id, created_at FROM due_deferred
         )
         SELECT id
         FROM ${tableName}
         INNER JOIN candidates USING (id)
         WHERE state = 'queued'
           OR (
             state = 'deferred'
             AND defer_until <= $1
           )
         ORDER BY candidates.created_at ASC, candidates.id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, 1, base.appId],
      );
      expect(first.rows.map((row) => row.id)).toEqual([
        'admission-lock-queued',
      ]);

      const second = await liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-lock-probe',
        claimToken: 'claim-token-lock-probe',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 1,
        now,
      });
      expect(second.map((item) => item.id)).toEqual(['admission-lock-due-1']);
    } finally {
      await held.query('ROLLBACK').catch(() => undefined);
      held.release();
      await runtime.service.pool.query(
        `UPDATE ${tableName}
         SET state = 'completed',
             ended_at = $1,
             updated_at = $1
         WHERE id = ANY($2::text[])`,
        [now, ids],
      );
    }
  });

  it('keeps original message order for deferred retries inside the candidate window', async () => {
    const ids = [
      'admission-due-old-later-ready',
      'admission-due-newer-earlier-ready',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:20.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse('2026-06-16T00:00:20.000Z') + index),
      });
    }
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'deferred',
           defer_until = CASE
             WHEN id = $1 THEN '2000-01-02T00:00:00.000Z'::timestamptz
             ELSE '2000-01-01T00:00:00.000Z'::timestamptz
           END,
           deferred_reason = 'retry',
           updated_at = '2026-06-16T00:00:30.000Z'::timestamptz
       WHERE id = ANY($2::text[])`,
      [ids[0], ids],
    );

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-due-order',
      claimToken: 'claim-token-due-order',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
      now: '2001-01-01T00:00:00.000Z',
    });
    expect(claimed.map((item) => item.id)).toEqual([
      'admission-due-old-later-ready',
    ]);

    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed',
           ended_at = '2026-06-16T00:00:31.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:31.000Z'::timestamptz
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  });

  it('keeps original message order for expired claims inside the candidate window', async () => {
    const ids = [
      'admission-expired-old-later-expiry',
      'admission-expired-newer-earlier-expiry',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:40.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse('2026-06-16T00:00:40.000Z') + index),
      });
    }
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'claimed',
           claim_worker_instance_id = 'stale-worker',
           claim_token = 'stale-token',
           claim_expires_at = CASE
             WHEN id = $1 THEN '2000-01-02T00:00:00.000Z'::timestamptz
             ELSE '2000-01-01T00:00:00.000Z'::timestamptz
           END,
           claimed_at = '2026-06-16T00:00:41.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:41.000Z'::timestamptz
       WHERE id = ANY($2::text[])`,
      [ids[0], ids],
    );

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-expired-order',
      claimToken: 'claim-token-expired-order',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
      now: '2001-01-01T00:00:00.000Z',
    });
    expect(claimed.map((item) => item.id)).toEqual([
      'admission-expired-old-later-expiry',
    ]);

    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed',
           ended_at = '2026-06-16T00:00:42.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:42.000Z'::timestamptz
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  });

  it('stores an inbound message and live admission work item in one repository call', async () => {
    const message = {
      id: 'msg-atomic-1',
      chat_jid: 'tg:live-admission-atomic',
      provider: 'telegram',
      sender: 'user-atomic',
      sender_name: 'Atomic User',
      content: 'sensitive prompt body',
      timestamp: '2026-06-16T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    };

    const result = await runtime.ops.storeMessageWithLiveAdmission?.(message, {
      appId: 'default',
      agentId: 'atomic_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });

    expect(result?.outcome).toBe('enqueued');
    expect(result?.item).toMatchObject({
      appId: 'default',
      agentId: 'agent:atomic_agent',
      conversationId: 'tg:live-admission-atomic',
      threadId: null,
      providerAccountId: 'channel-providerAccount:default:telegram',
      queueJid:
        'tg:live-admission-atomic::agent:agent%3Aatomic_agent::provider_account:channel-providerAccount%3Adefault%3Atelegram',
      messageId:
        'message:channel-providerAccount:default:telegram:tg:live-admission-atomic:msg-atomic-1',
      senderUserId: 'user-atomic',
      senderDisplayName: 'Atomic User',
      state: 'queued',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });
    expect(JSON.stringify(result?.item)).not.toContain('sensitive prompt body');

    const admissionFilter = parseAgentThreadQueueKey(
      result?.item.queueJid ?? '',
    );
    const providerAccountId = admissionFilter.providerAccountId;
    expect(providerAccountId).toBe('channel-providerAccount:default:telegram');
    expect(result?.item.messageId).toBe(
      `message:${providerAccountId}:${message.chat_jid}:${message.id}`,
    );

    const conversationsTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('conversations')}`;
    const messagesTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('messages')}`;
    const { rows: identities } = await runtime.service.pool.query<{
      conversation_id: string;
      conversation_provider_account_id: string;
      message_id: string;
      message_provider_account_id: string;
    }>(
      `SELECT c.id AS conversation_id,
              c.provider_account_id AS conversation_provider_account_id,
              m.id AS message_id,
              m.provider_account_id AS message_provider_account_id
       FROM ${messagesTable} m
       JOIN ${conversationsTable} c ON c.id = m.conversation_id
       WHERE m.id = $1`,
      [result?.item.messageId],
    );
    expect(identities).toEqual([
      {
        conversation_id: `conversation:${providerAccountId}:${message.chat_jid}`,
        conversation_provider_account_id: providerAccountId,
        message_id: result?.item.messageId,
        message_provider_account_id: providerAccountId,
      },
    ]);

    await expect(
      runtime.ops.getMessagesSince(admissionFilter.chatJid, '', 10, {
        threadId: admissionFilter.threadId ?? null,
        providerAccountId,
      }),
    ).resolves.toMatchObject([
      {
        id: 'msg-atomic-1',
        content: 'sensitive prompt body',
      },
    ]);

    const replay = await runtime.ops.storeMessageWithLiveAdmission?.(message, {
      appId: 'default',
      agentId: 'atomic_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });
    expect(replay?.outcome).toBe('replayed');
    expect(replay?.item.id).toBe(result?.item.id);

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-no-notify',
      claimToken: 'claim-token-no-notify',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(result?.item.id);
  });

  it('reuses an existing installation account for a providerless follow-up', async () => {
    const chatJid = 'tg:live-admission-existing-install';
    const providerAccountId = 'telegram-install-existing' as ProviderAccountId;
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId: DEFAULT_APP_ID as AppId,
      agentId: DEFAULT_AGENT_ID as AgentId,
      providerId: 'telegram' as ProviderId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'telegram-install-existing',
      },
      label: 'Existing Telegram installation',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-06-16T00:00:02.000Z',
      updatedAt: '2026-06-16T00:00:02.000Z',
    });
    await runtime.ops.storeMessage({
      id: 'msg-install-seed',
      chat_jid: chatJid,
      provider: 'telegram',
      providerAccountId,
      sender: 'user-install',
      sender_name: 'Install User',
      content: 'seed with installation account',
      timestamp: '2026-06-16T00:00:02.100Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const followUp = {
      id: 'msg-install-follow-up',
      chat_jid: chatJid,
      provider: 'telegram',
      sender: 'user-install',
      sender_name: 'Install User',
      content: 'providerless follow-up',
      timestamp: '2026-06-16T00:00:02.200Z',
      is_from_me: false,
      is_bot_message: false,
    };
    const result = await runtime.ops.storeMessageWithLiveAdmission?.(followUp, {
      appId: 'default',
      agentId: 'install_agent',
      triggerDecision: { requiresTrigger: false },
    });

    expect(result?.outcome).toBe('enqueued');
    const admissionFilter = parseAgentThreadQueueKey(
      result?.item.queueJid ?? '',
    );
    expect(admissionFilter.providerAccountId).toBe(providerAccountId);
    expect(result?.item.messageId).toBe(
      `message:${providerAccountId}:${chatJid}:${followUp.id}`,
    );

    const conversationsTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('conversations')}`;
    const messagesTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('messages')}`;
    const { rows: conversations } = await runtime.service.pool.query<{
      id: string;
      provider_account_id: string;
    }>(
      `SELECT id, provider_account_id
       FROM ${conversationsTable}
       WHERE external_ref_json::jsonb->>'jid' = $1
       ORDER BY id`,
      [chatJid],
    );
    expect(conversations).toEqual([
      {
        id: `conversation:${providerAccountId}:${chatJid}`,
        provider_account_id: providerAccountId,
      },
    ]);

    const { rows: messages } = await runtime.service.pool.query<{
      conversation_id: string;
      provider_account_id: string;
    }>(
      `SELECT conversation_id, provider_account_id
       FROM ${messagesTable}
       WHERE id = $1`,
      [result?.item.messageId],
    );
    expect(messages).toEqual([
      {
        conversation_id: `conversation:${providerAccountId}:${chatJid}`,
        provider_account_id: providerAccountId,
      },
    ]);

    await expect(
      runtime.ops.getMessagesSince(admissionFilter.chatJid, '', 10, {
        threadId: admissionFilter.threadId ?? null,
        providerAccountId: admissionFilter.providerAccountId,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: followUp.id,
          content: followUp.content,
        }),
      ]),
    );
  });

  it('unions message reads across every conversation row for a jid', async () => {
    const chatJid = 'app:default:session-read-union';
    // Sessions path creates a legacy-shaped row; a later providerless
    // admission creates the account-qualified twin. Readers that only know
    // the jid (GET /v1/sessions/{id}/messages) must see messages from BOTH
    // until the Phase-8 restamp collapses them.
    await runtime.ops.storeChatMetadata(
      chatJid,
      '2026-06-16T00:00:04.000Z',
      'Session Read Union',
      'app',
    );
    const result = await runtime.ops.storeMessageWithLiveAdmission?.(
      {
        id: 'msg-session-read-union',
        chat_jid: chatJid,
        sender: 'api',
        sender_name: 'API',
        content: 'hello across rows',
        timestamp: '2026-06-16T00:00:04.100Z',
        is_from_me: false,
        is_bot_message: false,
      },
      {
        appId: 'default',
        agentId: 'main_agent',
        triggerDecision: { requiresTrigger: false },
      },
    );
    expect(result?.outcome).toBe('enqueued');

    const conversationIds =
      await runtime.repositories.messages.listConversationIdsForJid(chatJid);
    expect(conversationIds.length).toBeGreaterThanOrEqual(1);
    const lists = await Promise.all(
      conversationIds.map((conversationId) =>
        runtime.repositories.messages.listRecentMessages({
          conversationId,
          limit: 10,
        }),
      ),
    );
    const union = lists.flat();
    expect(
      union.some((message) =>
        message.parts.some(
          (part) => part.kind === 'text' && part.text === 'hello across rows',
        ),
      ),
    ).toBe(true);
  });

  it('stores accepted runtime event and live admission atomically', async () => {
    const message = {
      id: 'msg-event-admission-1',
      chat_jid: 'tg:live-admission-event-atomic',
      provider: 'telegram',
      sender: 'user-event-admission',
      sender_name: 'Event Admission User',
      content: 'accepted event and admission body',
      timestamp: '2026-06-16T00:00:03.000Z',
      is_from_me: false,
      is_bot_message: false,
    };

    const result =
      await runtime.storageRuntime.runtimeEvents.publishWithLiveAdmissionMessage(
        {
          appId: 'default' as never,
          eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
          actor: 'sdk',
          payload: {
            messageId: message.id,
            text: message.content,
          },
          createdAt: message.timestamp,
        },
        {
          message,
          liveAdmission: {
            appId: 'default',
            agentId: 'event_admission_agent',
            triggerDecision: {
              source: 'sdk_session',
            },
            now: message.timestamp,
          },
        },
      );

    expect(result.event).toMatchObject({
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      payload: {
        messageId: message.id,
        text: message.content,
      },
    });
    expect(result.liveAdmissionResult?.item).toMatchObject({
      state: 'queued',
      messageId:
        'message:channel-providerAccount:default:telegram:tg:live-admission-event-atomic:msg-event-admission-1',
    });
    await expect(
      runtime.ops.getMessagesSince('tg:live-admission-event-atomic', '', 10, {
        threadId: null,
      }),
    ).resolves.toMatchObject([
      {
        id: 'msg-event-admission-1',
        content: 'accepted event and admission body',
      },
    ]);

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-event-admission',
      claimToken: 'claim-token-event-admission',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(
      result.liveAdmissionResult?.item.id,
    );
  });
});

import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import '@core/channels/register-builtins.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import type { ChannelWiringDeps } from '@core/app/bootstrap/channel-wiring-types.js';
import {
  createRuntimeApp,
  type RuntimeApp,
} from '@core/app/bootstrap/runtime-app.js';
import { ConversationMessageIngressModule } from '@core/application/external-ingress/conversation-message-ingress.js';
import { isSessionCommandText } from '@core/application/sessions/session-command-parse.js';
import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';
import { DEFAULT_TRIGGER, getTriggerPattern } from '@core/config/index.js';
import { resolveConversationMessageRoute } from '@core/control/server/external-ingress-adapter.js';
import { adaptSessionControlPort } from '@core/control/server/session-control-port.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { agentIdForFolder } from '@core/domain/agent/agent-folder-id.js';
import type { LiveAdmissionWorkItem } from '@core/domain/ports/live-turns.js';
import {
  processLiveAdmissionWorkItem,
  recoverPendingMessages,
  type MessageLoopDeps,
} from '@core/runtime/message-loop.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const commandAdmins = vi.hoisted(() => new Set<string>());
vi.mock('@core/platform/sender-allowlist.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@core/platform/sender-allowlist.js')>();
  return {
    ...actual,
    isSenderControlAllowed: (
      ...args: Parameters<typeof actual.isSenderControlAllowed>
    ) => commandAdmins.has(args[1]) || actual.isSenderControlAllowed(...args),
  };
});

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('quiet window before a turn starts (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let table: string;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'quiet_window',
    });
    table = `${quotePostgresIdentifier(runtime.schemaName)}.live_admission_work_items`;
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  const save = async (
    appId: string,
    message: {
      id: string;
      chatJid: string;
      provider: string;
      content: string;
      sender?: string;
      providerAccountId?: string;
      // The inbound handler's decision for this route.
      sessionCommand?: boolean;
      timestamp?: string;
    },
    agentId?: string,
  ): Promise<LiveAdmissionWorkItem> => {
    const result = await runtime.ops.storeMessageWithLiveAdmission(
      {
        id: message.id,
        chat_jid: message.chatJid,
        provider: message.provider,
        ...(message.providerAccountId
          ? { providerAccountId: message.providerAccountId }
          : {}),
        sender: message.sender ?? 'user',
        sender_name: 'User',
        content: message.content,
        timestamp: message.timestamp ?? toIso(nowMs()),
        is_from_me: false,
        is_bot_message: false,
      },
      {
        appId,
        ...(agentId ? { agentId } : {}),
        sessionCommand: message.sessionCommand,
      },
    );
    if (result?.outcome !== 'enqueued') throw new Error('Admission failed');
    return result.item;
  };

  // Seconds from each item's own receipt (database clock) to when it is due.
  const waits = async (appId: string) => {
    const { rows } = await runtime.service.pool.query<{
      id: string;
      state: string;
      wait: number | null;
      sinceFirst: number | null;
    }>(
      `SELECT id, state,
              extract(epoch FROM defer_until - created_at)::float8 AS wait,
              extract(epoch FROM defer_until - min(created_at) OVER ())::float8 AS "sinceFirst"
       FROM ${table} WHERE app_id = $1 ORDER BY receive_order`,
      [appId],
    );
    return rows;
  };

  const moveBack = (id: string, seconds: number) =>
    runtime.service.pool.query(
      `UPDATE ${table}
       SET created_at = created_at - make_interval(secs => $2),
           defer_until = defer_until - make_interval(secs => $2)
       WHERE id = $1`,
      [id, seconds],
    );

  it('restarts the wait for the whole conversation on each new message', async () => {
    const appId = 'quiet-restart';
    const chatJid = 'tg:quiet-restart';
    const first = await save(appId, {
      id: 'm1',
      chatJid,
      provider: 'telegram',
      content: 'first part',
    });
    const [only] = await waits(appId);
    expect(only).toMatchObject({ state: 'deferred' });
    expect(only!.wait).toBeCloseTo(1.5, 1);

    await moveBack(first.id, 1);
    await save(appId, {
      id: 'm2',
      chatJid,
      provider: 'telegram',
      content: 'second part',
      sender: 'another-user',
    });
    const [older, newer] = await waits(appId);
    expect(newer!.wait).toBeCloseTo(1.5, 1);
    // Both are due together, 1.5 s after the newest one.
    expect(older!.sinceFirst).toBe(newer!.sinceFirst);
    expect(older!.wait).toBeGreaterThan(2.45);
    // The admission loop sleeps until exactly this time.
    const [{ deferUntil }] = (
      await runtime.service.pool.query<{ deferUntil: string }>(
        `SELECT defer_until::text AS "deferUntil" FROM ${table} WHERE app_id = $1 LIMIT 1`,
        [appId],
      )
    ).rows as [{ deferUntil: string }];
    expect(
      await runtime.repositories.liveTurns.nextLiveAdmissionDueAt({ appId }),
    ).toBe(deferUntil);
  });

  it('never waits more than 6 seconds after the first message', async () => {
    const appId = 'quiet-cap';
    const chatJid = 'tg:quiet-cap';
    const first = await save(appId, {
      id: 'm1',
      chatJid,
      provider: 'telegram',
      content: 'first part',
    });
    await moveBack(first.id, 5);
    await save(appId, {
      id: 'm2',
      chatJid,
      provider: 'telegram',
      content: 'late part',
    });
    expect((await waits(appId)).map((row) => row.sinceFirst)).toEqual([6, 6]);
  });

  // The wait follows what a user can send in one message on each platform.
  it.each([
    [
      'a Telegram text near its limit',
      'telegram',
      'tg',
      Math.ceil(4096 * 0.9),
      4,
    ],
    ['a Discord text near its Nitro limit', 'discord', 'dc', 3600, 4],
    ['a 2,000-character Discord text', 'discord', 'dc', 2000, 1.5],
    [
      'any text on a platform with no known limit',
      'teams',
      'teams',
      50_000,
      1.5,
    ],
  ])(
    'waits the right time after %s',
    async (_name, provider, prefix, length, wait) => {
      const appId = `quiet-length-${provider}-${length}`;
      await save(appId, {
        id: 'm1',
        chatJid: `${prefix}:${appId}`,
        provider,
        content: 'x'.repeat(length),
      });
      const [row] = await waits(appId);
      expect(row!.wait).toBeCloseTo(wait, 1);
    },
  );

  async function appConversation(appId: string, trigger = 'Andy') {
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const folder = appId.replace(/-/g, '_');
    const chatJid = `app:${appId}:conversation`;
    const providerAccountId = `control:${appId}`;
    const session = await runtime.control.ensureAppSession({
      appId,
      conversationId: 'conversation',
      chatJid,
      workspaceFolder: folder,
    });
    const channel = createFakeChannelRuntime((jid) => jid === chatJid);
    const prompts: string[] = [];
    const app = createRuntimeApp({
      opsRepository: runtime.ops,
      ensureCredentialBinding: async () => ({ created: false }),
      runAgent: async (_group, input, _onProcess, onOutput) => {
        prompts.push(input.prompt);
        await onOutput?.({ status: 'success', result: 'Answered.' });
        return { status: 'success', result: 'Answered.' };
      },
    });
    app.setChannelRuntime(channel.runtime);
    await app.registerGroup(chatJid, {
      name: 'Quiet window',
      folder,
      providerAccountId,
      trigger,
      added_at: toIso(nowMs()),
      requiresTrigger: false,
      conversationKind: 'dm',
      agentConfig: { model: 'opus' },
    });
    const agentId = agentIdForFolder(folder);
    const loopDeps = (
      enqueueMessageCheck: MessageLoopDeps['queue']['enqueueMessageCheck'] = () =>
        undefined,
    ): MessageLoopDeps => ({
      appId,
      inputRepository: runtime.repositories.liveTurns,
      getConversationRoutes: app.getConversationRoutes,
      getTriggerPattern,
      hasChannel: () => true,
      setTyping: async () => undefined,
      sendProgressUpdate: async () => undefined,
      queue: {
        sendMessage: () => false,
        enqueueMessageCheck,
        closeStdin: () => undefined,
      },
      opsRepository: runtime.ops,
    });
    return {
      loopDeps,
      app,
      chatJid,
      conversationId: session.canonicalConversationId,
      prompts,
      replies: () => channel.outbound.map((message) => message.text),
      send: (
        id: string,
        content: string,
        sender = 'user',
        timestamp?: string,
      ) =>
        save(
          appId,
          {
            id,
            chatJid,
            provider: 'app',
            providerAccountId,
            content,
            sender,
            sessionCommand: isSessionCommandText(
              content,
              getTriggerPattern(trigger),
            ),
            timestamp,
          },
          agentId,
        ),
      claimLater: () =>
        runtime.repositories.liveTurns.claimLiveAdmissionWorkItems({
          appId,
          workerInstanceId: 'worker',
          claimToken: 'claim',
          claimExpiresAt: toIso(nowMs() + 60_000),
          limit: 10,
          now: toIso(nowMs() + 10_000),
        }),
    };
  }

  it('starts one turn with three quick messages from any sender, in received order', async () => {
    const conversation = await appConversation('quiet-batch');
    const first = await conversation.send('m1', 'alpha', 'ann');
    // Received second, but the provider's clock says it was sent first.
    await conversation.send('m2', 'beta', 'bob', toIso(nowMs() - 60_000));
    await conversation.send('m3', 'gamma', 'ann');

    // One due time for the whole batch, so one claim picks up all of it.
    expect(
      new Set((await waits('quiet-batch')).map((row) => row.sinceFirst)).size,
    ).toBe(1);
    const claimed = await conversation.claimLater();
    expect(claimed.map((item) => item.messageId)).toHaveLength(3);

    await conversation.app.processGroupMessages(first.queueJid, {
      existingRunId: 'run:batch',
    });
    await conversation.app.processGroupMessages(first.queueJid, {
      existingRunId: 'run:after-batch',
    });
    expect(conversation.prompts).toHaveLength(1);
    const prompt = conversation.prompts[0]!.split('<current_message')[1]!;
    expect(prompt.indexOf('alpha')).toBeLessThan(prompt.indexOf('beta'));
    expect(prompt.indexOf('beta')).toBeLessThan(prompt.indexOf('gamma'));
  });

  const consumers = async (items: LiveAdmissionWorkItem[]) =>
    (
      await runtime.service.pool.query<{ consumed_by: string | null }>(
        `SELECT consumed_by FROM ${table}
         WHERE id = ANY($1) ORDER BY receive_order`,
        [items.map((item) => item.id)],
      )
    ).rows.map((row) => row.consumed_by);

  const endWindow = (item: LiveAdmissionWorkItem) =>
    runtime.service.pool.query(
      `UPDATE ${table} SET defer_until = clock_timestamp() WHERE id = $1`,
      [item.id],
    );

  it('answers /stop at once with no turn running, keeps the batch before it as history, and gives a later message its own turn', async () => {
    const conversation = await appConversation('quiet-stop-idle');
    commandAdmins.add('admin');
    const waiting = [
      await conversation.send('m1', 'do the thing', 'admin'),
      await conversation.send('m2', 'and this too', 'admin'),
    ];
    const stop = await conversation.send('m3', '/stop', 'admin');
    expect(stop).toMatchObject({ state: 'queued', deferUntil: null });
    const later = await conversation.send('m4', 'a new request', 'admin');

    // A recovery wake reaches turn start, which takes only the /stop.
    let runs = 0;
    await recoverPendingMessages(
      conversation.loopDeps(async (queueJid) => {
        runs += 1;
        await conversation.app.processGroupMessages(queueJid, {
          existingRunId: `run:stop-${runs}`,
        });
      }),
    );
    expect(conversation.replies()).toEqual(['No active run to stop.']);
    expect(await consumers([...waiting, stop, later])).toEqual([
      'stopped',
      'stopped',
      'turn:run:stop-1',
      null,
    ]);

    await endWindow(later);
    await conversation.app.processGroupMessages(later.queueJid, {
      existingRunId: 'run:later',
    });
    expect(conversation.prompts).toHaveLength(1);
    // The cancelled batch is history: context, never the turn's input.
    const current = conversation.prompts[0]!.split('<current_message')[1];
    expect(current).toContain('a new request');
    expect(current).not.toContain('do the thing');
  });

  it('cancels a full batch whose window ended while it waited for capacity', async () => {
    const conversation = await appConversation('quiet-stop-capacity');
    commandAdmins.add('admin');
    const waiting: LiveAdmissionWorkItem[] = [];
    for (let index = 1; index <= 10; index += 1) {
      waiting.push(await conversation.send(`m${index}`, `request ${index}`));
    }
    // The admission worker hands them to a queue that is busy with another
    // conversation: their window is over, but no turn has taken them.
    for (const item of await conversation.claimLater()) {
      await runtime.repositories.liveTurns.settleLiveAdmissionWorkItem({
        id: item.id,
        claimToken: 'claim',
        workerInstanceId: 'worker',
        state: 'completed',
      });
    }
    const stop = await conversation.send('m11', '/stop', 'admin');

    let runs = 0;
    const deps: MessageLoopDeps = {
      ...conversation.loopDeps(async (queueJid) => {
        runs += 1;
        await conversation.app.processGroupMessages(queueJid, {
          existingRunId: `run:capacity-${runs}`,
        });
      }),
      // No turn is running, so the active-run handler refuses.
      handleActiveControlCommand: async () => false,
    };
    await processLiveAdmissionWorkItem(deps, stop);
    expect(conversation.prompts).toEqual([]);
    expect(conversation.replies()).toEqual(['No active run to stop.']);
    expect(await consumers(waiting)).toEqual(Array(10).fill('stopped'));
  });

  it('cancels only the batch received before /stop when the admission worker stops a running turn', async () => {
    const conversation = await appConversation('quiet-stop-active');
    commandAdmins.add('admin');
    const waiting = [
      await conversation.send('m1', 'do the thing', 'admin'),
      await conversation.send('m2', 'and this too', 'admin'),
    ];
    const stop = await conversation.send('m3', '/stop', 'admin');
    const later = await conversation.send('m4', 'a new request', 'admin');

    const stopped: string[] = [];
    const deps: MessageLoopDeps = {
      ...conversation.loopDeps(),
      // The running turn's owner stops it.
      handleActiveControlCommand: async ({ command }) => {
        stopped.push(command.kind);
        return true;
      },
    };
    expect(await processLiveAdmissionWorkItem(deps, stop)).toBe('completed');
    expect(stopped).toEqual(['stop']);
    expect(await consumers([...waiting, stop, later])).toEqual([
      'stopped',
      'stopped',
      `control:${stop.id}`,
      null,
    ]);

    await endWindow(later);
    await conversation.app.processGroupMessages(later.queueJid, {
      existingRunId: 'run:later',
    });
    expect(conversation.prompts).toHaveLength(1);
    // The cancelled batch is history: context, never the turn's input.
    const current = conversation.prompts[0]!.split('<current_message')[1];
    expect(current).toContain('a new request');
    expect(current).not.toContain('do the thing');
  });

  it('stops a running turn at once on "@<agent> /stop" in a chat with no trigger of its own', async () => {
    const conversation = await appConversation('quiet-stop-default', '');
    commandAdmins.add('admin');
    const stop = await conversation.send(
      'm1',
      `${DEFAULT_TRIGGER} /stop`,
      'admin',
    );
    expect(stop).toMatchObject({ state: 'queued', deferUntil: null });

    const stopped: string[] = [];
    const deps: MessageLoopDeps = {
      ...conversation.loopDeps(),
      // The running turn's owner stops it.
      handleActiveControlCommand: async ({ command }) => {
        stopped.push(command.kind);
        return true;
      },
    };
    expect(await processLiveAdmissionWorkItem(deps, stop)).toBe('completed');
    expect(stopped).toEqual(['stop']);
    expect(await consumers([stop])).toEqual([`control:${stop.id}`]);
  });

  it('never makes a session command wait, in any form the route accepts', async () => {
    const chatJid = 'tg:quiet-command-forms';
    const route: ConversationRoute = {
      name: 'Command forms',
      folder: 'main_agent',
      agentId: DEFAULT_AGENT_ID,
      trigger: '@Andy',
      added_at: toIso(nowMs()),
      requiresTrigger: false,
      conversationKind: 'dm',
    };
    const handlers = createChannelPersistenceHandlers({
      app: {
        getConversationRoutes: () => ({ [chatJid]: route }),
      } as unknown as RuntimeApp,
      resolved: {
        appId: DEFAULT_APP_ID,
        logger: { info: () => undefined, warn: () => undefined },
        getTriggerPattern,
      } as unknown as ChannelWiringDeps,
      ops: () => runtime.ops,
      persistenceQueue: new AsyncTaskQueue(1, 4),
      runtimeSettings: () => ({}) as never,
    });
    const forms: Array<[string, string | undefined, string]> = [
      ['/stop', undefined, 'queued'],
      ['@Andy /stop', undefined, 'queued'],
      ['@Andy ! stop', undefined, 'queued'],
      ['@Andy !new', undefined, 'queued'],
      ['/gantry status', undefined, 'queued'],
      ['/stop', 'topic-7', 'queued'],
      ['/home/user is full', undefined, 'deferred'],
      ['hello there', 'topic-7', 'deferred'],
    ];
    for (const [index, [content, threadId]] of forms.entries()) {
      await handlers.onMessage(chatJid, {
        id: `form-${index}`,
        chat_jid: chatJid,
        provider: 'telegram',
        sender: 'user',
        sender_name: 'User',
        content,
        timestamp: toIso(nowMs()),
        is_from_me: false,
        is_bot_message: false,
        ...(threadId ? { thread_id: threadId } : {}),
      });
    }
    const { rows } = await runtime.service.pool.query<{ state: string }>(
      `SELECT state FROM ${table} WHERE conversation_id = $1 ORDER BY receive_order`,
      [chatJid],
    );
    expect(rows.map((row) => row.state)).toEqual(
      forms.map(([, , state]) => state),
    );
  });

  it('never makes a session command from an SDK session wait', async () => {
    const sessions = new SessionInteractionModule({
      control: adaptSessionControlPort(runtime.control),
      ops: runtime.ops,
      repositories: {} as never,
      runtimeEvents: runtime.storageRuntime.runtimeEvents,
      getTriggerPattern,
      now: () => toIso(nowMs()) as never,
      createId: randomUUID,
      stableHash: (input) => createHash('sha256').update(input).digest('hex'),
    });
    const { session } = await sessions.ensureSession({
      appId: 'quiet-sdk',
      conversationId: 'conversation',
    });
    // An SDK group has no trigger, so turn start parses with the default one.
    for (const message of [
      '/stop',
      'please hold on',
      '/gantry new',
      `${DEFAULT_TRIGGER} /stop`,
    ]) {
      await sessions.acceptMessage(
        { appId: 'quiet-sdk', sessionId: session.sessionId, message },
        DEFAULT_APP_ID,
      );
    }
    const { rows } = await runtime.service.pool.query<{ state: string }>(
      `SELECT state FROM ${table} WHERE conversation_id = $1 ORDER BY receive_order`,
      [session.conversationJid],
    );
    expect(rows.map((row) => row.state)).toEqual([
      'queued',
      'deferred',
      'queued',
      'queued',
    ]);
  });

  it('never makes a session command from external ingress wait, under the route trigger', async () => {
    const conversation = await appConversation('quiet-ingress');
    const ingress = new ConversationMessageIngressModule({
      conversations: {
        // The app session's conversation, addressed as a provider one is.
        getConversation: async (
          id: Parameters<
            typeof runtime.repositories.conversations.getConversation
          >[0],
        ) => {
          const stored =
            await runtime.repositories.conversations.getConversation(id);
          return (
            stored && {
              ...stored,
              externalRef: {
                kind: 'conversation',
                value: conversation.chatJid,
              },
            }
          );
        },
      } as never,
      ops: runtime.ops,
      runtimeEvents: runtime.storageRuntime.runtimeEvents,
      liveAdmissionAppId: 'quiet-ingress',
      isConversationRoutable: () => true,
      providerForConversationJid: () => 'app',
      makeQueueKey: (jid) => jid,
      getTriggerPattern,
      resolveRoute: ({ conversationJid, threadId, providerAccountId }) =>
        resolveConversationMessageRoute(
          conversation.app.getConversationRoutes(),
          conversationJid,
          threadId,
          providerAccountId,
        ),
      now: () => toIso(nowMs()),
      createId: randomUUID,
    });
    // The route's trigger is Andy.
    const messages = ['Andy /stop', 'Andy ! stop', 'Andy, are you there?'];
    for (const [index, message] of messages.entries()) {
      await ingress.acceptMessage({
        appId: 'quiet-ingress',
        invocationId: `ingress-${index}`,
        conversationId: conversation.conversationId,
        message,
        senderId: 'ops-bot',
      });
    }
    const { rows } = await runtime.service.pool.query<{ state: string }>(
      `SELECT state FROM ${table} WHERE app_id = $1 ORDER BY receive_order`,
      ['quiet-ingress'],
    );
    expect(rows.map((row) => row.state)).toEqual([
      'queued',
      'queued',
      'deferred',
    ]);
  });

  it('starts no turn when a recovery wake lands inside the window', async () => {
    const conversation = await appConversation('quiet-recovery');
    await conversation.send('m1', 'still typing', 'ann');
    await conversation.send('m2', 'one more thing', 'bob');
    // Hold the window open through the database clock, however slow the host.
    await runtime.service.pool.query(
      `UPDATE ${table} SET defer_until = clock_timestamp() + interval '1 minute' WHERE app_id = $1`,
      ['quiet-recovery'],
    );
    let runs = 0;
    const deps = conversation.loopDeps(async (queueJid) => {
      runs += 1;
      await conversation.app.processGroupMessages(queueJid, {
        existingRunId: `run:recovery-${runs}`,
      });
    });

    await recoverPendingMessages(deps);
    expect(runs).toBe(1);
    expect(conversation.prompts).toEqual([]);

    await runtime.service.pool.query(
      `UPDATE ${table} SET defer_until = clock_timestamp() WHERE app_id = $1`,
      ['quiet-recovery'],
    );
    await recoverPendingMessages(deps);
    expect(conversation.prompts).toHaveLength(1);
    expect(conversation.prompts[0]).toContain('still typing');
    expect(conversation.prompts[0]).toContain('one more thing');
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import '@core/channels/register-builtins.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { agentIdForFolder } from '@core/domain/agent/agent-folder-id.js';
import type { LiveAdmissionWorkItem } from '@core/domain/ports/live-turns.js';
import {
  processLiveAdmissionWorkItem,
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
        timestamp: toIso(nowMs()),
        is_from_me: false,
        is_bot_message: false,
      },
      { appId, ...(agentId ? { agentId } : {}) },
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

  it('waits 4 seconds after a text near the platform limit', async () => {
    const appId = 'quiet-near-limit';
    await save(appId, {
      id: 'm1',
      chatJid: 'tg:quiet-near-limit',
      provider: 'telegram',
      content: 'x'.repeat(Math.ceil(4096 * 0.9)),
    });
    const [row] = await waits(appId);
    expect(row!.wait).toBeCloseTo(4, 1);
  });

  it('waits 1.5 seconds on a platform with no known limit', async () => {
    const appId = 'quiet-no-limit';
    await save(appId, {
      id: 'm1',
      chatJid: 'teams:quiet-no-limit',
      provider: 'teams',
      content: 'x'.repeat(50_000),
    });
    const [row] = await waits(appId);
    expect(row!.wait).toBeCloseTo(1.5, 1);
  });

  async function appConversation(appId: string) {
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const folder = appId.replace(/-/g, '_');
    const chatJid = `app:${appId}:conversation`;
    const providerAccountId = `control:${appId}`;
    await runtime.control.ensureAppSession({
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
      trigger: 'Andy',
      added_at: toIso(nowMs()),
      requiresTrigger: false,
      conversationKind: 'dm',
      agentConfig: { model: 'opus' },
    });
    const agentId = agentIdForFolder(folder);
    return {
      app,
      chatJid,
      prompts,
      send: (id: string, content: string, sender = 'user') =>
        save(
          appId,
          { id, chatJid, provider: 'app', providerAccountId, content, sender },
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

  it('starts one turn with three quick messages from any sender, in order', async () => {
    const conversation = await appConversation('quiet-batch');
    const first = await conversation.send('m1', 'alpha', 'ann');
    await conversation.send('m2', 'beta', 'bob');
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
    const prompt = conversation.prompts[0]!;
    expect(prompt.indexOf('alpha')).toBeLessThan(prompt.indexOf('beta'));
    expect(prompt.indexOf('beta')).toBeLessThan(prompt.indexOf('gamma'));
  });

  it('applies /stop at once and keeps the waiting batch as history', async () => {
    const conversation = await appConversation('quiet-stop');
    commandAdmins.add('admin');
    const waiting = [
      await conversation.send('m1', 'do the thing', 'admin'),
      await conversation.send('m2', 'and this too', 'admin'),
    ];
    const stop = await conversation.send('m3', '/stop', 'admin');
    expect(stop).toMatchObject({ state: 'queued', deferUntil: null });

    expect(waiting.map((item) => item.state)).toEqual(['deferred', 'deferred']);

    const stopped: string[] = [];
    const deps: MessageLoopDeps = {
      appId: 'quiet-stop',
      inputRepository: runtime.repositories.liveTurns,
      getConversationRoutes: conversation.app.getConversationRoutes,
      getOrRecoverCursor: conversation.app.getOrRecoverCursor,
      setAgentCursor: conversation.app.setAgentCursor,
      saveState: conversation.app.saveState,
      hasChannel: () => true,
      setTyping: async () => undefined,
      sendProgressUpdate: async () => undefined,
      queue: {
        sendMessage: () => false,
        enqueueMessageCheck: () => undefined,
        closeStdin: () => undefined,
      },
      opsRepository: runtime.ops,
      handleActiveControlCommand: async ({ command }) => {
        stopped.push(command.kind);
        return true;
      },
    };
    expect(await processLiveAdmissionWorkItem(deps, stop)).toBe('completed');
    expect(stopped).toEqual(['stop']);

    const { rows } = await runtime.service.pool.query<{
      id: string;
      consumed_by: string;
    }>(
      `SELECT id, consumed_by FROM ${table}
       WHERE id = ANY($1) ORDER BY receive_order`,
      [waiting.map((item) => item.id)],
    );
    expect(rows.map((row) => row.consumed_by)).toEqual(['stopped', 'stopped']);
    await conversation.app.processGroupMessages(stop.queueJid, {
      existingRunId: 'run:after-stop',
    });
    expect(conversation.prompts).toEqual([]);
  });
});

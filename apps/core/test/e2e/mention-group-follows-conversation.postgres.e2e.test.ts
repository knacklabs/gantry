import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildLiveAdmissionProcessor } from '@core/app/bootstrap/live-execution.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { RUNTIME_SETTINGS_PATH } from '@core/config/index.js';
import { agentIdForFolder } from '@core/domain/agent/agent-folder-id.js';
import type { NewMessage } from '@core/domain/types.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
import { LiveTurnAuthority } from '@core/runtime/live-turn-authority.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const chatJid = 'tg:-100777';
const folder = 'mention_follow';
const member = '1001';
const stranger = '2002';

// The owner's sender policy: only the member may bring the agent in.
const senderPolicySettings = `defaults:
  model: opus
providers:
  telegram:
    enabled: true
provider_accounts:
  mention_follow_telegram:
    agent: ${folder}
    provider: telegram
    label: Telegram
    runtime_secret_refs: {}
conversations:
  mention_follow_group:
    provider_account: mention_follow_telegram
    external_id: "-100777"
    kind: group
    display_name: Mention follow
    sender_policy:
      allow: ["${member}"]
      mode: trigger
    control_approvers: []
    installed_agents:
      ${folder}:
        provider_account: mention_follow_telegram
        added_at: "2026-01-01T00:00:00.000Z"
        trigger: "@Andy"
        requires_trigger: true
agents:
  ${folder}:
    name: ${folder}
    access:
      sources:
        skills: []
        mcp_servers: []
        tools: []
      selections: []
storage:
  postgres:
    url_env: GANTRY_DATABASE_URL
    schema: gantry
memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-small
  dreaming:
    enabled: false
`;

maybeDescribe(
  'mention-required group follows the conversation (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let originalSettings: string;

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'mention_follow',
      });
      const { _setRuntimeStorageForTest } =
        await import('@core/adapters/storage/postgres/runtime-store.js');
      _setRuntimeStorageForTest(runtime.storageRuntime);
      originalSettings = fs.readFileSync(RUNTIME_SETTINGS_PATH, 'utf-8');
      fs.writeFileSync(RUNTIME_SETTINGS_PATH, senderPolicySettings, 'utf-8');
    }, 60_000);

    afterAll(async () => {
      if (originalSettings !== undefined)
        fs.writeFileSync(RUNTIME_SETTINGS_PATH, originalSettings, 'utf-8');
      await runtime?.cleanup();
    });

    it('answers the conversation without new mentions and ignores unrelated or disallowed messages', async () => {
      const appId = 'mention-follow';
      const providerAccountId = 'channel-providerAccount:default:telegram';
      const liveTurns = runtime.repositories.liveTurns;
      await runtime.control.ensureAppSession({
        appId,
        conversationId: 'mention-follow',
        chatJid,
        workspaceFolder: folder,
      });
      const presented: string[] = [];
      const midTurn: string[] = [];
      let releaseHeldTurn!: () => void;
      const heldTurnReleased = new Promise<void>((resolve) => {
        releaseHeldTurn = resolve;
      });
      let replies = 0;
      // The channel stores what it sent, as the real outbound projection does.
      const channel = createFakeChannelRuntime((jid) => jid === chatJid, {
        sendMessage: async (jid, text, options) => {
          replies += 1;
          await runtime.ops.storeMessage({
            id: `outbound:mention-follow-${replies}`,
            chat_jid: jid,
            provider: 'telegram',
            providerAccountId,
            sender: 'gantry',
            sender_name: 'Gantry',
            content: text,
            timestamp: toIso(nowMs()),
            is_from_me: true,
            is_bot_message: true,
            thread_id: options?.threadId,
            external_message_id: `${9000 + replies}`,
            delivery_status: 'sent',
          });
        },
      });
      // Only the model is faked: its runner takes mid-turn input like the real one.
      const queue = new GroupQueue({
        maxMessageRuns: 2,
        maxRetries: 0,
        runnerControlPort: {
          writeContinuationInput: ({ text }) => {
            midTurn.push(text);
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
            `run-${presented.length}`,
          );
          if (presented.length === 1) await heldTurnReleased;
          const result = {
            status: 'success' as const,
            result: `Answer ${presented.length}.`,
          };
          await onOutput?.(result);
          return result;
        },
      });
      app.setChannelRuntime(channel.runtime);
      await app.registerGroup(chatJid, {
        name: 'Mention follow',
        folder,
        providerAccountId,
        trigger: '@Andy',
        added_at: toIso(nowMs()),
        requiresTrigger: true,
        conversationKind: 'group',
        agentConfig: { model: 'opus' },
      });
      const worker = async (id: string, ownerPollMs?: number) => {
        await runtime.repositories.workerCoordination.registerWorker({
          id,
          bootNonce: id,
        });
        const authority = new LiveTurnAuthority({
          leaseDeps: {
            liveTurns,
            coordination: runtime.repositories.workerCoordination,
            workerInstanceId: id,
          },
          slotCapacity: () => 2,
          ownerPollMs,
        });
        const processor = buildLiveAdmissionProcessor({
          appId,
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
        return { authority, processor };
      };
      const owner = await worker('mention-follow-owner', 250);
      const other = await worker('mention-follow-other');
      queue.setLiveTurnRunnerRegistrar((jid, hooks, routing) =>
        owner.authority.registerLocalRunner(jid, hooks, routing),
      );
      queue.setProcessMessagesFn((jid, context) =>
        owner.processor(jid, context),
      );
      const queueJids = new Set<string>();
      const save = async (
        message: Pick<NewMessage, 'id' | 'content'> & Partial<NewMessage>,
      ) => {
        const admitted = await runtime.ops.storeMessageWithLiveAdmission(
          {
            chat_jid: chatJid,
            provider: 'telegram',
            providerAccountId,
            sender: member,
            sender_name: 'Member',
            timestamp: toIso(nowMs()),
            is_from_me: false,
            is_bot_message: false,
            external_message_id: message.id,
            ...message,
          },
          { appId, agentId: agentIdForFolder(folder), providerAccountId },
        );
        if (!admitted || admitted.outcome === 'overloaded')
          throw new Error('Admission failed');
        queueJids.add(admitted.item.queueJid);
        return admitted.item.queueJid;
      };
      const settled = () =>
        vi.waitFor(
          async () => {
            expect(
              await liveTurns.listUnconsumedLiveAdmissionQueueJids({ appId }),
            ).toEqual([]);
            for (const jid of queueJids)
              expect(queue.isGroupActive(jid)).toBe(false);
          },
          { timeout: 15_000, interval: 50 },
        );
      const context = await runtime.ops.getAgentTurnContext({
        appId,
        agentFolder: folder,
        executionProviderId: 'anthropic:claude-agent-sdk',
        conversationJid: chatJid,
        providerAccountId,
        threadId: null,
        hydrateMemory: false,
      });
      if (!context) throw new Error('Missing agent session');
      const mainScope = {
        appId,
        agentSessionId: context.agentSessionId,
        conversationId: chatJid,
        threadId: null,
      };

      // A split mention: only the first part carries the bot mention.
      await save({
        id: '501',
        content: '@andy_bot draft the launch plan:',
        mentionsBot: true,
      });
      const mainQueue = await save({
        id: '502',
        content: 'step two, ship beta',
      });
      queue.enqueueMessageCheck(mainQueue);
      await vi.waitFor(
        async () =>
          expect(
            (await liveTurns.getActiveLiveTurn({ scope: mainScope }))?.state,
          ).toBe('running'),
        { timeout: 15_000, interval: 50 },
      );
      expect(presented).toHaveLength(1);
      expect(presented[0]).toContain('draft the launch plan:');
      expect(presented[0]).toContain('step two, ship beta');

      // While the agent works: another worker forwards the member's message to
      // the running agent and keeps the stranger's as history.
      await save({ id: '503', content: 'use metric units' });
      expect(await other.processor(mainQueue)).toBe(true);
      await save({
        id: '504',
        content: 'buy my course',
        sender: stranger,
        sender_name: 'Stranger',
      });
      expect(await other.processor(mainQueue)).toBe(true);
      await vi.waitFor(() => expect(midTurn).toHaveLength(1), {
        timeout: 15_000,
        interval: 50,
      });
      expect(midTurn[0]).toContain('use metric units');
      // This worker is busy, so its message waits for the next turn.
      await save({ id: '505', content: 'and the budget?' });
      queue.enqueueMessageCheck(mainQueue);
      releaseHeldTurn();
      await vi.waitFor(() => expect(presented).toHaveLength(2), {
        timeout: 15_000,
        interval: 50,
      });
      await settled();
      expect(presented[1]).toContain('and the budget?');
      // History is context, never the message the agent answers.
      const asked = (prompt: string) => prompt.split('<current_message').at(-1);
      expect(presented.map(asked).join('\n')).not.toContain('buy my course');
      expect(midTurn.join('\n')).not.toContain('buy my course');
      expect(channel.outbound.map(({ text }) => text)).toEqual([
        'Answer 1.',
        'Answer 2.',
      ]);

      // A plain reply to the bot's message.
      queue.enqueueMessageCheck(
        await save({
          id: '506',
          content: 'can you shorten it?',
          reply_to_message_id: '9001',
        }),
      );
      await settled();
      expect(presented).toHaveLength(3);
      expect(presented[2]).toContain('can you shorten it?');

      // A topic the bot answered in, then a follow-up there with no mention.
      queue.enqueueMessageCheck(
        await save({ id: '507', content: '@Andy plan Q3', thread_id: '42' }),
      );
      await settled();
      expect(presented).toHaveLength(4);
      expect(channel.outbound[3]?.options?.threadId).toBe('42');
      queue.enqueueMessageCheck(
        await save({
          id: '508',
          content: 'add a risks section',
          thread_id: '42',
        }),
      );
      await settled();
      expect(presented).toHaveLength(5);
      expect(presented[4]).toContain('add a risks section');

      // Unrelated chatter and a disallowed sender stay history.
      queue.enqueueMessageCheck(
        await save({ id: '509', content: 'lunch anyone?' }),
      );
      await settled();
      queue.enqueueMessageCheck(
        await save({
          id: '510',
          content: '@Andy reply to me',
          sender: stranger,
          sender_name: 'Stranger',
          mentionsBot: true,
          reply_to_message_id: '9001',
        }),
      );
      await settled();
      expect(presented).toHaveLength(5);
      expect(channel.outbound).toHaveLength(5);

      await owner.authority.shutdown();
      await other.authority.shutdown();
      await queue.shutdown(500);
    }, 90_000);
  },
);

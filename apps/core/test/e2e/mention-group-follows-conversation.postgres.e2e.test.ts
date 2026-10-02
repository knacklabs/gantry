import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { agentIdForFolder } from '@core/domain/agent/agent-folder-id.js';
import type { NewMessage } from '@core/domain/types.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe(
  'mention-required group follows the conversation (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'mention_follow',
      });
      const { _setRuntimeStorageForTest } =
        await import('@core/adapters/storage/postgres/runtime-store.js');
      _setRuntimeStorageForTest(runtime.storageRuntime);
    }, 60_000);

    afterAll(async () => {
      await runtime?.cleanup();
    });

    it("answers an unmentioned follow-up in the bot's Slack thread and keeps an unrelated message as history", async () => {
      const appId = 'mention-follow';
      const chatJid = 'sl:C0FOLLOW';
      const folder = 'mention_follow';
      const providerAccountId = 'channel-providerAccount:default:slack';
      await runtime.control.ensureAppSession({
        appId,
        conversationId: 'mention-follow',
        chatJid,
        workspaceFolder: folder,
      });
      const presented: string[] = [];
      let replies = 0;
      // The channel stores what it sent, as the real outbound projection does.
      const channel = createFakeChannelRuntime((jid) => jid === chatJid, {
        sendMessage: async (jid, text, options) => {
          replies += 1;
          await runtime.ops.storeMessage({
            id: `outbound:mention-follow-${replies}`,
            chat_jid: jid,
            provider: 'slack',
            providerAccountId,
            sender: 'gantry',
            sender_name: 'Gantry',
            content: text,
            timestamp: toIso(nowMs()),
            is_from_me: true,
            is_bot_message: true,
            thread_id: options?.threadId,
            external_message_id: `1710000900.00000${replies}`,
            delivery_status: 'sent',
          });
        },
      });
      const app = createRuntimeApp({
        opsRepository: runtime.ops,
        ensureCredentialBinding: async () => ({ created: false }),
        runAgent: async (_group, input, _onProcess, onOutput) => {
          presented.push(input.prompt);
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
      const sendAndProcess = async (
        message: Pick<NewMessage, 'id' | 'content'> & Partial<NewMessage>,
      ) => {
        const admitted = await runtime.ops.storeMessageWithLiveAdmission(
          {
            chat_jid: chatJid,
            provider: 'slack',
            providerAccountId,
            sender: 'U0PERSON',
            sender_name: 'Person',
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
        expect(
          await app.processGroupMessages(admitted.item.queueJid, {
            existingRunId: `run:${message.id}`,
            admissionAppId: appId,
          }),
        ).toBe(true);
      };

      const rootTs = '1710000000.000100';
      await sendAndProcess({ id: rootTs, content: '@Andy plan the launch' });
      expect(presented).toHaveLength(1);
      expect(channel.outbound[0]?.options?.threadId).toBe(rootTs);

      await sendAndProcess({
        id: '1710000000.000200',
        content: 'also add a budget line',
        thread_id: rootTs,
        reply_to_message_id: rootTs,
      });
      expect(presented).toHaveLength(2);
      expect(presented[1]).toContain('also add a budget line');
      expect(channel.outbound).toHaveLength(2);

      await sendAndProcess({
        id: '1710000100.000300',
        content: 'lunch anyone?',
      });
      expect(presented).toHaveLength(2);
      expect(channel.outbound).toHaveLength(2);
      expect(
        await runtime.repositories.liveTurns.listUnconsumedLiveAdmissionQueueJids(
          { appId },
        ),
      ).toEqual([]);
      await app.queue.shutdown(500);
    }, 60_000);
  },
);

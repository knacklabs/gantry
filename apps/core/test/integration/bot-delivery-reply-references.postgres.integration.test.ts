import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Only the provider edges supply IDs. Expectations below come from messages
// visible at those edges, independently of Gantry's delivery receipts.
const providerEdge = vi.hoisted(() => ({
  visibleIds: [] as string[],
  failPostAt: 0,
  postCount: 0,
  uploadFails: false,
  sequence: 0,
  parentChannelId: '',
  visibleId() {
    const id = `1800000000.${++this.sequence}`;
    this.visibleIds.push(id);
    return id;
  },
}));

vi.mock('@slack/bolt', () => ({
  SocketModeReceiver: class {
    client = { on() {} };
  },
  App: class {
    client = {
      auth: { test: async () => ({ ok: true, user_id: 'U_BOT' }) },
      chat: {
        postMessage: async () => ({ ok: true, ts: providerEdge.visibleId() }),
        update: async () => ({ ok: true }),
        delete: async () => ({ ok: true }),
      },
      apiCall: async () => ({ ok: false, error: 'unknown_method' }),
      files: {
        getUploadURLExternal: async () => ({
          ok: true,
          upload_url: 'https://files.slack.com/test-upload',
          file_id: 'F_REPLY_PROOF',
        }),
        // Slack's successful completion contract omits shares.
        completeUploadExternal: async () => {
          providerEdge.visibleId();
          return {
            ok: true,
            files: [{ id: 'F_REPLY_PROOF', title: 'Answer' }],
          };
        },
        info: async () => ({
          ok: true,
          file: {
            id: 'F_REPLY_PROOF',
            shares: {
              public: { C_REPLY: [{ ts: providerEdge.visibleIds.at(-1) }] },
            },
          },
        }),
      },
    };
    async stop() {}
  },
}));

import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import { createRecoveryDispatchPermit } from '@core/app/bootstrap/channel-wiring-delivery-guards.js';
import type { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { sendCoreMessage } from '@core/application/core-tools/send-message.js';
import { persistBotMessage } from '@core/application/messages/bot-message-persistence.js';
import type {
  ChannelAdapter,
  ChannelOpts,
} from '@core/channels/channel-provider.js';
import { DiscordChannel } from '@core/channels/discord/index.js';
import { resolveDiscordConversationContext } from '@core/channels/discord/conversation-context.js';
import { SlackChannel } from '@core/channels/slack/channel-adapter.js';
import {
  getProvider,
  type Provider,
} from '@core/channels/provider-registry.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import type { NewMessage } from '@core/domain/types.js';
import { createGroupOutputBuffer } from '@core/runtime/group-output-buffer.js';
import { decideBatch } from '@core/runtime/group-trigger-policy.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const log = { info() {}, warn() {}, debug() {}, error() {} };

const cases = [
  { name: 'outbound send', provider: 'discord', path: 'outbound', chars: 20 },
  {
    name: 'send_message chunks',
    provider: 'discord',
    path: 'core',
    chars: 4500,
  },
  {
    name: 'outbound chunks',
    provider: 'discord',
    path: 'outbound',
    chars: 4500,
  },
  {
    name: 'recovery chunks',
    provider: 'discord',
    path: 'recovery',
    chars: 4500,
  },
  { name: 'file upload', provider: 'discord', path: 'file', chars: 4500 },
  {
    name: 'file upload failure warning',
    provider: 'discord',
    path: 'file',
    chars: 4500,
    uploadFails: true,
  },
  {
    name: 'partial outbound chunks',
    provider: 'discord',
    path: 'outbound',
    chars: 6500,
    failPostAt: 3,
  },
  {
    name: 'completed stream chunks',
    provider: 'discord',
    path: 'stream',
    chars: 6500,
  },
  {
    name: 'Discord reply while the bot is streaming',
    provider: 'discord',
    path: 'stream',
    chars: 20,
    live: true,
  },
  {
    name: 'Discord thread opened on a still-streaming bot message',
    provider: 'discord',
    path: 'stream',
    chars: 20,
    live: true,
    opensThread: true,
  },
  {
    name: 'Slack thread opened on a still-streaming bot message',
    provider: 'slack',
    path: 'stream',
    chars: 20,
    live: true,
    opensThread: true,
  },
  {
    name: 'partial stream chunks',
    provider: 'discord',
    path: 'stream',
    chars: 6500,
    failPostAt: 3,
  },
  {
    name: 'stream reset before final delivery',
    provider: 'discord',
    path: 'stream',
    chars: 20,
    resetBeforeFinal: true,
  },
  {
    name: 'Slack snippet without completion shares',
    provider: 'slack',
    path: 'stream',
    chars: 16001,
  },
  {
    name: 'Slack long file without completion shares',
    provider: 'slack',
    path: 'stream',
    chars: 1048600,
  },
  {
    name: 'Slack attachment without completion shares',
    provider: 'slack',
    path: 'file',
    chars: 20,
  },
] as const;

maybeDescribe(
  'reply references for provider-visible bot deliveries (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'bot_reply_parts',
      });
    });
    afterAll(async () => {
      await runtime?.cleanup();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(cases)(
      'a reply to every visible part reaches the agent: $name',
      async (scenario) => {
        providerEdge.visibleIds = [];
        providerEdge.postCount = 0;
        providerEdge.failPostAt =
          'failPostAt' in scenario ? scenario.failPostAt : 0;
        providerEdge.uploadFails =
          'uploadFails' in scenario && scenario.uploadFails;
        vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
          if (String(_url).includes('files.slack.com'))
            return new Response('', { status: 200 });
          if (init?.body instanceof FormData && providerEdge.uploadFails)
            return new Response('{}', { status: 400 });
          if (init?.method === 'POST') {
            providerEdge.postCount += 1;
            if (providerEdge.postCount === providerEdge.failPostAt)
              return new Response('{}', { status: 500 });
            return Response.json({ id: providerEdge.visibleId() });
          }
          if (init?.method === 'GET')
            return Response.json({
              type: 11,
              parent_id: providerEdge.parentChannelId,
            });
          return Response.json({});
        });

        const providerAccountId = `${scenario.provider}_reply_parts`;
        const jid =
          scenario.provider === 'slack'
            ? 'sl:C_REPLY'
            : `dc:reply-${cases.indexOf(scenario)}`;
        providerEdge.parentChannelId = jid.slice(3);
        const opts: ChannelOpts = {
          providerAccountId,
          onMessage: async () => 'stored',
          onChatMetadata: async () => {},
        };
        const channel: ChannelAdapter =
          scenario.provider === 'slack'
            ? new SlackChannel('test-token', 'test-app-token', opts)
            : new DiscordChannel('test-token', 'test-app', opts);
        const provider: Provider = {
          ...getProvider(scenario.provider)!,
          create: () => channel,
          isEnabled: () => true,
        };
        // App lifecycle is irrelevant to provider delivery; the real wiring and DB
        // own delivery, persistence, and subsequent reply lookup.
        const app = {
          queue: {},
          getConversationRoutes: () => ({}),
          setChannelRuntime() {},
          setHistoryCoverageDistrustEpochReader() {},
          setConversationHistoryCoverageRepository() {},
        } as unknown as RuntimeApp;
        const wiring = createChannelWiring(app, {
          providerIds: [provider],
          opsRepository: runtime.ops,
          historyCoverage: runtime.repositories.conversationHistoryCoverage,
          getTriggerPattern: () => /^@Gantry\b/,
          logger: log,
        });
        const settings = createDefaultRuntimeSettings();
        settings.providerAccounts = {
          [providerAccountId]: {
            provider: scenario.provider,
            agentId: 'main_agent',
            label: 'Reply proof',
            runtimeSecretRefs: {},
          },
        };
        await wiring.connectEnabledChannels(settings, {
          providerInbound: false,
        });
        const text = 'x'.repeat(scenario.chars);
        const sendMessage = (
          target: string,
          value: string,
          options?: Parameters<ChannelAdapter['sendMessage']>[2],
        ) =>
          wiring.sendMessage(target, value, {
            durability: 'best_effort',
            throwOnMissing: true,
            messageOptions: options,
          });
        let finishStream: (() => Promise<boolean>) | undefined;
        try {
          if (scenario.path === 'stream') {
            let status: 'none' | 'sent' | 'partially_sent' = 'none';
            const buffer = createGroupOutputBuffer({
              channelRuntime: wiring,
              chatJid: jid,
              groupName: 'Reply proof',
              supportsStreamingChunks: true,
              buildStreamingOptions: ({ done }) => ({
                done,
                providerAccountId,
              }),
              buildMessageOptions: () => ({ providerAccountId }),
              sendMessageToChannel: (value, options) =>
                sendMessage(jid, value, options),
              applyDeliverySettlement: (settlement) => {
                if (settlement === 'sent') status = 'sent';
                if (settlement === 'delivery_incomplete')
                  status = 'partially_sent';
              },
              getStreamedTranscriptDeliveryStatus: () => status,
              persistCompletedStreamedGeneration: async (
                content,
                deliveryStatus,
                receipts,
              ) => {
                await persistBotMessage(
                  runtime.ops,
                  {
                    id: `stream:${scenario.name}`,
                    chat_jid: jid,
                    providerAccountId,
                    sender: 'gantry',
                    sender_name: 'Gantry',
                    content,
                    timestamp: new Date().toISOString(),
                    is_from_me: true,
                    is_bot_message: true,
                    delivery_status: deliveryStatus,
                  },
                  receipts,
                );
              },
              log,
            });
            await buffer.appendRawOutput(text);
            if ('resetBeforeFinal' in scenario) wiring.resetStreaming(jid);
            // Live cases evaluate replies while generation output is still open.
            finishStream = () => buffer.flushBufferedOutput('turn complete');
            if (!('live' in scenario)) await finishStream();
          } else if (scenario.path === 'core') {
            await sendCoreMessage({
              message: { text },
              context: {
                sourceAgentFolder: 'main_agent',
                targetJid: jid,
                providerAccountId,
              },
              deps: { sendMessage },
            });
          } else if (scenario.path === 'recovery') {
            const permit = createRecoveryDispatchPermit({
              deliveryId: 'delivery',
              itemId: 'item',
              destinationJid: jid,
              canonicalText: text,
            });
            await wiring.sendProviderMessage(jid, text, {
              permit,
              messageOptions: { providerAccountId },
            });
          } else {
            const attempt = sendMessage(jid, text, {
              providerAccountId,
              ...(scenario.path === 'file'
                ? {
                    files: [
                      {
                        filename: 'answer.txt',
                        contentType: 'text/plain',
                        content: Buffer.from('answer'),
                        sizeBytes: 6,
                      },
                    ],
                  }
                : {}),
            });
            if ('failPostAt' in scenario)
              await expect(attempt).rejects.toThrow();
            else await attempt;
          }

          expect(providerEdge.visibleIds.length).toBeGreaterThan(0);
          if (scenario.chars > 2000 && scenario.provider === 'discord')
            expect(providerEdge.visibleIds.length).toBeGreaterThan(1);
          if ('uploadFails' in scenario)
            expect(providerEdge.visibleIds).toHaveLength(4);
          const replyIsForAgent = (
            externalId: string,
            account = providerAccountId,
            route: { chatJid: string; threadId?: string } = { chatJid: jid },
            isDirectReply = true,
          ) => {
            const reply: NewMessage = {
              id: `reply:${externalId}`,
              chat_jid: route.chatJid,
              providerAccountId: account,
              sender: 'member',
              sender_name: 'Member',
              content: 'Please explain this part.',
              timestamp: new Date().toISOString(),
              ...(isDirectReply ? { reply_to_message_id: externalId } : {}),
              thread_id: route.threadId,
            };
            return decideBatch({
              group: {
                folder: 'main_agent',
                requiresTrigger: true,
                providerAccountId: account,
              },
              chatJid: route.chatJid,
              threadId: route.threadId,
              triggerPattern: /^@Gantry\b/,
              messages: [reply],
              receivedDuringTurn: new Set(),
              messageRepository: runtime.ops,
            });
          };
          for (const id of providerEdge.visibleIds) {
            let route: { chatJid: string; threadId?: string } = { chatJid: jid };
            if ('opensThread' in scenario) {
              if (scenario.provider === 'discord') {
                const context = await resolveDiscordConversationContext({
                  channelId: id,
                  botToken: 'test-token',
                  cache: new Map(),
                  headers: () => ({}),
                  requestJson: async <T>(path: string, init: RequestInit) => {
                    const response = await fetch(
                      `https://discord.com/api/v10${path}`,
                      init,
                    );
                    return (await response.json()) as T;
                  },
                });
                route = {
                  chatJid: context.conversationJid,
                  threadId: context.threadId,
                };
              } else route = { chatJid: jid, threadId: id };
            }
            expect(
              await replyIsForAgent(id, providerAccountId, route),
              `reply to provider-visible ${id}`,
            ).toBe(true);
            expect(
              await replyIsForAgent(id, `${providerAccountId}_other`, route),
            ).toBe(false);
            if ('live' in scenario)
              expect(
                await replyIsForAgent(id, providerAccountId, {
                  ...route,
                  chatJid:
                    scenario.provider === 'discord'
                      ? 'dc:unrelated-parent'
                      : 'sl:C_UNRELATED',
                }),
              ).toBe(false);
            if ('opensThread' in scenario) {
              expect(
                await replyIsForAgent(id, providerAccountId, route, false),
                `unmentioned follow-up in the thread opened on ${id}`,
              ).toBe(true);
              expect(
                await replyIsForAgent(
                  id,
                  `${providerAccountId}_other`,
                  route,
                  false,
                ),
              ).toBe(false);
            }
          }
          expect(await replyIsForAgent('unrelated-message')).toBe(false);
          if ('live' in scenario) await finishStream?.();
        } finally {
          await wiring.disconnectChannels();
        }
      },
    );
  },
);

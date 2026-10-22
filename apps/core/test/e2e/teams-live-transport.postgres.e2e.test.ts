import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';

import { ConfigurationBotFrameworkAuthentication } from 'botbuilder';
import { ConnectorFactoryImpl } from 'botframework-connector/lib/auth/connectorFactoryImpl.js';
import { OpenIdMetadata } from 'botframework-connector/lib/auth/openIdMetadata.js';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { PostgresInboundEventRepository } from '@core/adapters/storage/postgres/repositories/inbound-event-repository.postgres.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import type { ChannelWiringDeps } from '@core/app/bootstrap/channel-wiring-types.js';
import { createDurableInboundMessages } from '@core/app/bootstrap/durable-inbound-messages.js';
import { buildLiveAdmissionProcessor } from '@core/app/bootstrap/live-execution.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { beginDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';
import { TeamsChannel } from '@core/channels/teams/index.js';
import type { TeamsAdaptiveCardPayload } from '@core/channels/teams/cards.js';
import { PostgresTeamsConversationRouteStore } from '@core/channels/teams/conversation-route-store.postgres.js';
import {
  createMicrosoftTeamsSdkClient,
  processTeamsActivity,
} from '@core/channels/teams/sdk-client.js';
import {
  getTriggerPattern,
  RUNTIME_SETTINGS_PATH,
} from '@core/config/index.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import type { ExecutionProviderId } from '@core/domain/sessions/sessions.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
import { LiveTurnAuthority } from '@core/runtime/live-turn-authority.js';
import { startTestControlServer } from '../harness/control-http-server.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const credentials = {
  clientId: 'teams-live-bot',
  clientSecret: 'test-secret',
  tenantId: 'teams-live-tenant',
};
const account = 'teams_live';
const alias = 'teams_live_alias';
const chat = '19:teams-live@thread.tacv2';
const jid = `teams:${chat}`;
const root = 'root-message';
const appId = 'default';
const folder = 'main_agent';
const agentId = 'agent:main_agent';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const scope = {
  appId,
  providerId: 'teams',
  connectionId: 'teams-live-connection',
};
const quietLogger = { info() {}, warn() {}, debug() {}, error() {} };

type MicrosoftMessage = {
  id?: string;
  text?: string;
  replyToId?: string;
  attachments?: Array<{ content: TeamsAdaptiveCardPayload }>;
};

// The three scenarios own the real HTTP -> storage -> runtime -> Teams path.
// Only Microsoft's discovery/delivery endpoints and the model runner are fake.
describe.skipIf(!hasPostgresIntegrationDatabase)(
  'teams-live-transport (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let server: Awaited<ReturnType<typeof startTestControlServer>>;
    let channel: TeamsChannel;
    let queue: GroupQueue;
    let authority: LiveTurnAuthority;
    let originalSettings: string;
    let recover: () => Promise<void>;
    const sent: Array<{ conversationId: string; message: MicrosoftMessage }> =
      [];
    const updated: MicrosoftMessage[] = [];
    const prompts: string[] = [];

    async function bearer() {
      return new SignJWT({
        serviceurl: 'https://smba.trafficmanager.net/teams-live/',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'teams-live-key' })
        .setIssuer('https://api.botframework.com')
        .setAudience(credentials.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
    }

    async function post(
      fields: Record<string, unknown>,
      providerAccountId = alias,
    ) {
      return fetch(
        `${server.baseUrl}/v1/providers/teams/${providerAccountId}/activities`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await bearer()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            type: 'message',
            id: globalThis.crypto.randomUUID(),
            channelId: 'msteams',
            serviceUrl: 'https://smba.trafficmanager.net/teams-live/',
            conversation: {
              id: `${chat};messageid=${root}`,
              conversationType: 'channel',
            },
            recipient: { id: '28:teams-live-bot', name: 'Gantry' },
            from: { id: 'permitted-person', name: 'Permitted person' },
            channelData: { tenant: { id: credentials.tenantId } },
            timestamp: new Date().toISOString(),
            ...fields,
          }),
        },
      );
    }

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'teams_live_transport',
      });
      _setRuntimeStorageForTest(runtime.storageRuntime);
      configurePendingInteractionDurability({
        repository: runtime.repositories.workerCoordination,
      });
      originalSettings = fs.readFileSync(RUNTIME_SETTINGS_PATH, 'utf-8');
      fs.writeFileSync(
        RUNTIME_SETTINGS_PATH,
        `defaults:
  model: opus
providers:
  teams:
    enabled: true
provider_accounts:
  ${account}:
    agent: ${folder}
    provider: teams
    label: Teams live
    runtime_secret_refs: {}
conversations:
  teams_live_chat:
    provider_account: ${account}
    external_id: "${chat}"
    kind: group
    display_name: Teams live
    sender_policy:
      allow: ["permitted-person"]
      mode: trigger
    control_approvers: ["permitted-person"]
    installed_agents:
      ${folder}:
        provider_account: ${account}
        added_at: "2026-01-01T00:00:00.000Z"
        trigger: "@Gantry"
        requires_trigger: false
agents:
  ${folder}:
    name: Main agent
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
`,
        'utf-8',
      );

      vi.spyOn(OpenIdMetadata.prototype, 'getKey').mockResolvedValue({
        key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        endorsements: ['msteams'],
      });
      vi.spyOn(ConnectorFactoryImpl.prototype, 'create').mockImplementation(
        async () =>
          ({
            conversations: {
              sendToConversation: async (
                conversationId: string,
                message: MicrosoftMessage,
              ) => {
                sent.push({ conversationId, message });
                return { id: `sent-${sent.length}` };
              },
              replyToActivity: async (
                conversationId: string,
                _activityId: string,
                message: MicrosoftMessage,
              ) => {
                sent.push({ conversationId, message });
                return { id: `sent-${sent.length}` };
              },
              updateActivity: async (
                _conversationId: string,
                _messageId: string,
                message: MicrosoftMessage,
              ) => {
                updated.push(message);
                return { id: 'updated-card' };
              },
            },
          }) as never,
      );
      vi.spyOn(
        ConfigurationBotFrameworkAuthentication.prototype,
        'createUserTokenClient',
      ).mockResolvedValue({} as never);

      await runtime.control.ensureAppSession({
        appId,
        conversationId: 'teams-live',
        chatJid: jid,
        workspaceFolder: folder,
      });
      queue = new GroupQueue({ maxMessageRuns: 1, maxRetries: 0 });
      const app = createRuntimeApp({
        queue,
        opsRepository: runtime.ops,
        ensureCredentialBinding: async () => ({ created: false }),
        runAgent: async (_group, input, onProcess, onOutput) => {
          prompts.push(input.prompt);
          onProcess(
            {
              pid: 0,
              kill: () => true,
              stdin: { end() {} },
            } as unknown as ChildProcess,
            'teams-live-run',
          );
          const result = {
            status: 'success' as const,
            result: 'The Teams agent reply.',
          };
          await onOutput?.(result);
          return result;
        },
      });
      await app.registerGroup(jid, {
        name: 'Teams live',
        folder,
        providerAccountId: account,
        trigger: '@Gantry',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        conversationKind: 'channel',
        agentConfig: { model: 'opus' },
      });
      const persistenceQueue = new AsyncTaskQueue(1, 16);
      const persistence = createChannelPersistenceHandlers({
        app,
        resolved: {
          appId,
          getTriggerPattern,
          logger: quietLogger,
        } as unknown as ChannelWiringDeps,
        ops: () => runtime.ops,
        persistenceQueue,
        runtimeSettings: () => ({}) as never,
      });
      const inbox = createDurableInboundMessages({
        repository: () =>
          new PostgresInboundEventRepository(runtime.service.db),
        processMessage: persistence.onMessage,
        warn() {},
      });
      recover = () => inbox.recover(scope);
      const admin = new ConversationAdministrationService(runtime.repositories);
      const opts = {
        providerAccountId: account,
        agentId,
        onChatMetadata: persistence.onChatMetadata,
        onMessage: (
          chatJid: string,
          message: Parameters<typeof persistence.onMessage>[1],
        ) =>
          inbox.save(scope, chatJid, {
            ...message,
            providerAccountId: account,
            agentId,
          }),
        conversationRoutes: () => app.getConversationRoutes(),
        isControlApproverAllowed: (input: {
          userId: string;
          conversationJid: string;
          threadId?: string;
        }) =>
          admin.isControlApproverAllowed({
            appId: appId as never,
            providerId: 'teams' as never,
            providerAccountId: account as never,
            agentId: agentId as never,
            conversationJid: input.conversationJid,
            threadId: input.threadId,
            userId: input.userId,
          }),
      };
      const makeChannel = () => {
        const sdk = createMicrosoftTeamsSdkClient(credentials, {
          providerAccountId: account,
          inboundProviderAccountIds: [account, alias],
          routeStore: new PostgresTeamsConversationRouteStore(
            runtime.service.db,
          ),
        });
        if (!sdk) throw new Error('Teams transport could not start');
        return new TeamsChannel(credentials, opts, sdk);
      };
      channel = makeChannel();
      await channel.connect();
      app.setChannelRuntime({
        hasChannel: (chatJid) => channel.ownsJid(chatJid),
        supportsStreaming: () => false,
        supportsProgress: () => false,
        sendMessage: async (chatJid, text, options) => {
          await channel.sendMessage(chatJid, text, options);
        },
        sendStreamingChunk: async () => false,
        resetStreaming() {},
        setTyping: async () => {},
        sendProgressUpdate: async () => {},
      });
      await runtime.repositories.workerCoordination.registerWorker({
        id: 'teams-live-worker',
        bootNonce: 'teams-live-worker',
      });
      authority = new LiveTurnAuthority({
        leaseDeps: {
          liveTurns: runtime.repositories.liveTurns,
          coordination: runtime.repositories.workerCoordination,
          workerInstanceId: 'teams-live-worker',
        },
        slotCapacity: () => 1,
      });
      const processor = buildLiveAdmissionProcessor({
        appId,
        inputRepository: runtime.repositories.liveTurns,
        liveTurnAuthority: authority,
        app,
        opsRepository: runtime.ops,
        executionAdapter: {
          id: 'anthropic:claude-agent-sdk' as ExecutionProviderId,
        },
        messageFetchPageSize: 50,
        timezone: 'UTC',
        getTriggerPattern,
        enqueueMessageCheck: (chatJid) => queue.enqueueMessageCheck(chatJid),
        warn() {},
      });
      queue.setLiveTurnRunnerRegistrar((chatJid, hooks, routing) =>
        authority.registerLocalRunner(chatJid, hooks, routing),
      );
      queue.setProcessMessagesFn((chatJid, context) =>
        processor(chatJid, context),
      );
      server = await startTestControlServer({
        token: 'teams-control-token',
        appId,
        scopes: ['*'],
        runtimeApp: app,
        routeProfile: 'ops',
        processRole: 'live-worker',
        processTeamsActivity,
      });

      restartChannel = async () => {
        await channel.disconnect();
        channel = makeChannel();
        await channel.connect();
      };
    }, 60_000);

    let restartChannel: () => Promise<void>;

    afterAll(async () => {
      await server?.close();
      await channel?.disconnect();
      await authority?.shutdown();
      await queue?.shutdown(500);
      configurePendingInteractionDurability(null);
      vi.restoreAllMocks();
      if (originalSettings !== undefined)
        fs.writeFileSync(RUNTIME_SETTINGS_PATH, originalSettings, 'utf-8');
      await runtime?.cleanup();
    });

    it('answers inbound text in the originating Teams conversation and thread', async () => {
      const response = await post({
        id: 'teams-person-message',
        text: '<at>Gantry</at> explain the release',
        entities: [
          {
            type: 'mention',
            mentioned: { id: '28:teams-live-bot' },
            text: '<at>Gantry</at>',
          },
        ],
      });
      expect(response.status).toBe(200);
      await recover();
      const persisted = await runtime.ops.getMessagesSince(jid, '', 20, {
        providerAccountId: account,
        threadId: root,
      });
      expect(persisted).toContainEqual(
        expect.objectContaining({
          id: 'teams-person-message',
          content: 'explain the release',
          thread_id: root,
          providerAccountId: account,
        }),
      );
      // Advance the quiet window via the database clock, then wake the real loop.
      await runtime.service.pool.query(
        "UPDATE live_admission_work_items SET defer_until = clock_timestamp() WHERE state = 'deferred' AND deferred_reason = 'quiet_window'",
      );
      for (const queueJid of await runtime.repositories.liveTurns.listUnconsumedLiveAdmissionQueueJids(
        { appId },
      ))
        queue.enqueueMessageCheck(queueJid);
      await vi.waitFor(
        () =>
          expect(sent).toContainEqual({
            conversationId: chat,
            message: expect.objectContaining({
              text: 'The Teams agent reply.',
              replyToId: root,
            }),
          }),
        { timeout: 15_000 },
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('explain the release');
      await vi.waitFor(async () => {
        expect(
          await runtime.repositories.liveTurns.listUnconsumedLiveAdmissionQueueJids(
            { appId },
          ),
        ).toEqual([]);
      });
    }, 30_000);

    it('delivers a proactive message through a fresh client using the previously saved Teams route', async () => {
      expect((await post({ type: 'conversationUpdate' })).status).toBe(200);
      await restartChannel();
      await channel.sendMessage(jid, 'Scheduled update after restart.', {
        threadId: root,
      });
      expect(sent).toContainEqual({
        conversationId: chat,
        message: expect.objectContaining({
          text: 'Scheduled update after restart.',
          replyToId: root,
        }),
      });
      await expect(
        channel.sendMessage(
          'teams:19:unseen@thread.tacv2',
          'Unseen destination',
        ),
      ).rejects.toThrow(/Send a message.*Teams/i);
    });

    it('keeps an approval pending after an unauthorized card submit and lets a permitted person decide', async () => {
      expect((await post({ type: 'conversationUpdate' })).status).toBe(200);
      const conversationId = `conversation:${account}:${jid}`;
      const graph = new PostgresCanonicalGraphRepository(runtime.service.db);
      await graph.ensureParticipant({
        conversationId,
        providerId: 'teams',
        providerAccountId: account,
        externalUserId: 'permitted-person',
      });
      await runtime.repositories.providerAccounts.saveConversationInstall({
        id: 'teams-live-install' as never,
        appId: appId as never,
        agentId: agentId as never,
        providerAccountId: account as never,
        conversationId: conversationId as never,
        displayName: 'Teams live',
        status: 'active',
        senderPolicy: 'provider_native',
        controlPolicy: 'conversation_approvers',
        memoryScope: 'conversation',
        memorySubject: {
          kind: 'conversation',
          appId: appId as never,
          conversationId: conversationId as never,
        },
        permissionPolicyIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await new ConversationAdministrationService(
        runtime.repositories,
      ).replaceControlAllowlist({
        appId: appId as never,
        conversationId: conversationId as never,
        userIds: ['permitted-person'],
        updatedAt: new Date().toISOString(),
      });
      const request: PermissionApprovalRequest = {
        requestId: 'teams-live-approval',
        appId,
        agentId,
        providerAccountId: account,
        sourceAgentFolder: folder,
        toolName: 'Bash',
        toolInput: { command: 'echo approved' },
        decisionPolicy: 'same_channel',
        decisionOptions: ['allow_once', 'cancel'],
        targetJid: jid,
        approvalContextJid: jid,
        threadId: root,
      };
      await beginDurablePermissionInteraction({
        request,
        sourceAgentFolder: folder,
        payload: { request },
      });
      let delivered!: () => void;
      const promptDelivered = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      let decided = false;
      const waiting = channel
        .requestPermissionApproval(jid, request, () => delivered())
        .then((result) => {
          decided = true;
          return result;
        });
      await promptDelivered;
      const card = sent.at(-1)?.message.attachments?.[0]?.content;
      expect(card?.type).toBe('AdaptiveCard');
      const action = card?.actions.find(
        (candidate) =>
          'data' in candidate &&
          candidate.data.action === 'permission_decision' &&
          candidate.data.decision === 'allow_once',
      );
      if (!action || !('data' in action))
        throw new Error('No approval action was delivered');
      const beforeUpdates = updated.length;
      const denied = await post({
        type: 'invoke',
        name: 'adaptiveCard/action',
        from: { id: 'unpermitted-person', name: 'Another person' },
        value: { action: { type: 'Action.Execute', data: action.data } },
      });
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({ statusCode: 200 });
      expect(decided).toBe(false);
      expect(updated).toHaveLength(beforeUpdates);
      expect(sent.at(-1)?.message.text).toBe(
        'You are not allowed to decide this permission request.',
      );
      const accepted = await post({
        type: 'invoke',
        name: 'adaptiveCard/action',
        value: { action: { type: 'Action.Execute', data: action.data } },
      });
      expect(accepted.status).toBe(200);
      expect(await waiting).toMatchObject({
        kind: 'decision',
        decision: {
          approved: true,
          mode: 'allow_once',
          decidedBy: 'permitted-person',
        },
      });
      expect(updated).toHaveLength(beforeUpdates + 1);
    }, 30_000);
  },
);

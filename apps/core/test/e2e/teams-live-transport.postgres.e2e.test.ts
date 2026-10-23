import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';

import { ConfigurationBotFrameworkAuthentication } from 'botbuilder';
import { ConnectorFactoryImpl } from 'botframework-connector/lib/auth/connectorFactoryImpl.js';
import { OpenIdMetadata } from 'botframework-connector/lib/auth/openIdMetadata.js';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import type { ChannelWiring } from '@core/app/bootstrap/channel-wiring-types.js';
import {
  startRuntimeServices,
  stopLiveAdmissionLoop,
  stopLiveTurnRecoveryLoop,
  shutdownLiveTurnAuthority,
  stopAsyncTaskRecoveryLoop,
} from '@core/app/bootstrap/runtime-services.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { beginDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';
import '@core/channels/register-builtins.js';
import { getProvider } from '@core/channels/provider-registry.js';
import type { TeamsAdaptiveCardPayload } from '@core/channels/teams/cards.js';
import { processTeamsActivity } from '@core/channels/teams/sdk-client.js';
import {
  getTriggerPattern,
  RUNTIME_SETTINGS_PATH,
} from '@core/config/index.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { loadRuntimeSettingsFromPath } from '@core/config/settings/runtime-settings.js';
import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import { stopWorkerHeartbeat } from '@core/jobs/worker-identity.js';
import { stopOutboundDeliveryRecoveryLoop } from '@core/jobs/outbound-delivery-recovery.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
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
    let wiring: ChannelWiring;
    let queue: GroupQueue;
    let originalSettings: string;
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
    runtime_secret_refs:
      client_id: env:TEAMS_CLIENT_ID
      client_secret: env:TEAMS_CLIENT_SECRET
      tenant_id: env:TEAMS_TENANT_ID
  ${alias}:
    agent: ${folder}
    provider: teams
    label: Teams sibling
    runtime_secret_refs:
      client_id: env:TEAMS_CLIENT_ID
      client_secret: env:TEAMS_CLIENT_SECRET
      tenant_id: env:TEAMS_TENANT_ID
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
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.origin === 'https://login.microsoftonline.com') {
          expect(url.pathname).toBe(
            `/${credentials.tenantId}/oauth2/v2.0/token`,
          );
          return Response.json({ access_token: 'teams-graph-test-token' });
        }
        if (url.origin === 'https://graph.microsoft.com') {
          expect(url.pathname).toBe(
            `/v1.0/chats/${encodeURIComponent(chat)}/members`,
          );
          return Response.json({
            value: [
              { userId: 'permitted-person' },
              { userId: 'unpermitted-person' },
            ],
          });
        }
        return realFetch(input, init);
      });

      vi.stubEnv('TEAMS_CLIENT_ID', credentials.clientId);
      vi.stubEnv('TEAMS_CLIENT_SECRET', credentials.clientSecret);
      vi.stubEnv('TEAMS_TENANT_ID', credentials.tenantId);

      await runtime.control.ensureAppSession({
        appId,
        conversationId: 'teams-live',
        chatJid: jid,
        workspaceFolder: folder,
      });
      const settings = loadRuntimeSettingsFromPath(RUNTIME_SETTINGS_PATH);
      const projection = await new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
      }).reconcile(settings);
      expect(projection.invalidReferences).toEqual([]);
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
      const teamsProvider = getProvider('teams');
      if (!teamsProvider) throw new Error('Teams provider is not registered');
      wiring = createChannelWiring(app, {
        getTriggerPattern,
        providerIds: [teamsProvider],
        opsRepository: runtime.ops,
        logger: quietLogger,
      });
      await wiring.connectEnabledChannels(settings, { providerInbound: true });
      expect(wiring.hasConnectedChannels()).toBe(true);
      app.setChannelRuntime({
        hasChannel: wiring.hasChannel,
        supportsStreaming: wiring.supportsStreaming,
        supportsProgress: wiring.supportsProgress,
        sendMessage: (chatJid, text, options) =>
          wiring.sendMessage(chatJid, text, {
            durability: 'required',
            messageOptions: options,
          }),
        sendStreamingChunk: wiring.sendStreamingChunk,
        resetStreaming: wiring.resetStreaming,
        setTyping: wiring.setTyping,
        sendProgressUpdate: async (chatJid, text, options) => {
          await wiring.sendProgressUpdate(chatJid, text, options);
        },
      });
      // Use the same bootstrap as the live worker. Its polling loop owns inbox
      // recovery, quiet-window eligibility and admission; this test only submits
      // an HTTP activity. Removing the production recovery callback strands it.
      await startRuntimeServices(
        {
          app,
          channelWiring: wiring,
          processRole: 'live-worker',
          jobExecution: false,
        },
        {
          opsRepository: runtime.ops,
          getToolRepository: () => runtime.repositories.tools,
          getWorkerCoordinationRepository: () =>
            runtime.repositories.workerCoordination,
          getLiveTurnRepository: () => runtime.repositories.liveTurns,
          getOutboundDeliveryRepository: () =>
            runtime.repositories.outboundDeliveries,
          startIpcWatcher: () => {},
          writeGroupsSnapshot: async () => {},
          logger: { ...quietLogger, fatal: quietLogger.error },
        },
      );
      server = await startTestControlServer({
        token: 'teams-control-token',
        appId,
        scopes: ['providers:read'],
        runtimeApp: app,
        routeProfile: 'ops',
        processRole: 'live-worker',
        processTeamsActivity,
      });

      restartChannel = async () => {
        await wiring.disconnectChannels();
        await wiring.connectEnabledChannels(settings, {
          providerInbound: true,
        });
      };
    }, 60_000);

    let restartChannel: () => Promise<void>;

    afterAll(async () => {
      const failures: unknown[] = [];
      // Continue cleanup after a failed setup/stop so no worker can retain the
      // disposable database, provider registration or developer settings.
      for (const cleanup of [
        () => server?.close(),
        () => stopLiveAdmissionLoop(5_000),
        () => stopLiveTurnRecoveryLoop(),
        () => stopAsyncTaskRecoveryLoop(),
        () => stopOutboundDeliveryRecoveryLoop(),
        () => shutdownLiveTurnAuthority(),
        () => stopWorkerHeartbeat(),
        () => wiring?.disconnectChannels(),
        () => queue?.shutdown(500),
        () => configurePendingInteractionDurability(null),
        () => vi.restoreAllMocks(),
        () => vi.unstubAllEnvs(),
        () => {
          if (originalSettings !== undefined)
            fs.writeFileSync(RUNTIME_SETTINGS_PATH, originalSettings, 'utf-8');
        },
        () => runtime?.cleanup(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Teams test cleanup failed');
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
      await vi.waitFor(
        () =>
          expect(sent).toContainEqual({
            conversationId: chat,
            message: expect.objectContaining({
              replyToId: root,
              attachments: expect.arrayContaining([
                expect.objectContaining({
                  content: expect.objectContaining({
                    body: expect.arrayContaining([
                      expect.objectContaining({
                        type: 'TextBlock',
                        text: 'The Teams agent reply.',
                      }),
                    ]),
                  }),
                }),
              ]),
            }),
          }),
        { timeout: 15_000 },
      );
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
      await wiring.sendMessage(jid, 'Scheduled update after restart.', {
        durability: 'required',
        messageOptions: { threadId: root, providerAccountId: account },
      });
      expect(sent).toContainEqual({
        conversationId: chat,
        message: expect.objectContaining({
          text: 'Scheduled update after restart.',
          replyToId: root,
        }),
      });
      await expect(
        wiring.sendMessage(
          'teams:19:unseen@thread.tacv2',
          'Unseen destination',
          {
            durability: 'best_effort',
            messageOptions: { providerAccountId: account },
          },
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
      const waiting = wiring
        .requestPermissionApproval(request, () => delivered())
        .then((result) => {
          decided = true;
          return result;
        });
      await promptDelivered;
      const card = sent.at(-1)?.message.attachments?.[0]?.content;
      expect(card?.type).toBe('AdaptiveCard');
      expect(card?.actions.map((candidate) => candidate.title)).toEqual([
        'Allow once',
        'Deny',
      ]);
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

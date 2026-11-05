import { createServer } from 'node:http';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LLM_PROFILE_ID } from '@core/adapters/storage/postgres/seeds.js';
import { PostgresAuthenticationRepository } from '@core/adapters/storage/postgres/repositories/authentication-repository.postgres.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { hashAuthToken } from '@core/application/auth/auth-foundations.js';
import { handleBrowserControlRoutes } from '@core/control/server/browser-route-dispatch.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';

import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';
import { PersonIdentityService } from '@core/application/identity/person-identity-service.js';
import { PostgresPersonIdentityRepository } from '@core/adapters/storage/postgres/repositories/person-identity-repository.postgres.js';

import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import { applyConversationInstallToSettings } from '@core/config/settings/conversation-install-settings.js';
import {
  createDefaultRuntimeSettings,
  ensureConfiguredAgent,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import type { AppId } from '@core/domain/app/app.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const APP_ID = 'default' as AppId;
const AGENT_FOLDER = 'conversation_agent';
const PROVIDER_ACCOUNT_ID = 'slack_conversation_agent';
const EXTERNAL_ID = 'C12345678';
const NOW = '2026-07-29T00:00:00.000Z';

maybeDescribe(
  'conversation install desired-state projection (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;

    beforeEach(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'conversation_install_settings',
      });
    }, 60_000);

    afterEach(async () => {
      if (runtime) await runtime.cleanup();
    });

    it('projects a generated conversation install without changing provider credentials', async () => {
      const authoredSettings = createDefaultRuntimeSettings();
      authoredSettings.desiredState.authoritative = true;
      ensureConfiguredAgent(authoredSettings, {
        agentId: AGENT_FOLDER,
        agentName: 'Conversation Agent',
        agentFolder: AGENT_FOLDER,
      });
      authoredSettings.providers.slack.enabled = true;
      authoredSettings.providerAccounts[PROVIDER_ACCOUNT_ID] = {
        agentId: AGENT_FOLDER,
        provider: 'slack',
        label: 'Conversation Slack',
        runtimeSecretRefs: {
          bot_token: 'gantry-secret:CONVERSATION_SLACK_BOT_TOKEN',
          app_token: 'gantry-secret:CONVERSATION_SLACK_APP_TOKEN',
        },
      };

      applyConversationInstallToSettings({
        settings: authoredSettings,
        conversation: {
          id: `conversation:${PROVIDER_ACCOUNT_ID}:${EXTERNAL_ID}` as never,
          externalRef: { kind: 'conversation', value: EXTERNAL_ID } as never,
          kind: 'channel',
          title: 'incident-room',
        },
        providerAccountId: PROVIDER_ACCOUNT_ID,
        agentFolder: AGENT_FOLDER,
        controlApprovers: ['U12345678'],
        now: NOW,
        displayName: 'Incident Room',
        senderPolicy: { allow: ['U12345678'], mode: 'trigger' },
        memoryScope: 'conversation',
        trigger: '@Incident',
        requiresTrigger: true,
      });

      const settings = parseRuntimeSettings(
        renderRuntimeSettingsYaml(authoredSettings),
      );
      const result = await new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
        clock: { now: () => NOW },
      }).reconcile(settings);

      expect(result.invalidReferences).toEqual([]);
      await expect(
        runtime.repositories.providerAccounts.getProviderAccount(
          PROVIDER_ACCOUNT_ID as never,
        ),
      ).resolves.toMatchObject({
        agentId: `agent:${AGENT_FOLDER}`,
        runtimeSecretRefs: {
          bot_token: 'gantry-secret:CONVERSATION_SLACK_BOT_TOKEN',
          app_token: 'gantry-secret:CONVERSATION_SLACK_APP_TOKEN',
        },
      });

      const conversation =
        await runtime.repositories.conversations.getConversationByExternalRef({
          appId: APP_ID,
          providerId: 'slack' as never,
          providerAccountId: PROVIDER_ACCOUNT_ID as never,
          externalConversationId: EXTERNAL_ID,
        });
      expect(conversation).toMatchObject({
        providerAccountId: PROVIDER_ACCOUNT_ID,
        externalRef: { kind: 'conversation', value: EXTERNAL_ID },
        kind: 'channel',
        title: 'Incident Room',
      });

      await expect(
        runtime.repositories.providerAccounts.getConversationInstall({
          appId: APP_ID,
          agentId: `agent:${AGENT_FOLDER}` as never,
          conversationId: conversation!.id,
        }),
      ).resolves.toMatchObject({
        providerAccountId: PROVIDER_ACCOUNT_ID,
        status: 'active',
        memoryScope: 'conversation',
      });

      const routes = await runtime.ops.getAllConversationRoutes();
      expect(Object.values(routes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            folder: AGENT_FOLDER,
            conversationId: conversation!.id,
            providerAccountId: PROVIDER_ACCOUNT_ID,
            trigger: '@Incident',
            requiresTrigger: true,
          }),
        ]),
      );
    });
    it('saves a first verified provider approver before any messages and preserves that authority on reconcile', async () => {
      const settings = createDefaultRuntimeSettings();
      settings.desiredState.authoritative = true;
      const folder = 'fresh_approver_agent';
      const accountId = 'fresh_teams_account';
      const ownerId = 'first-team-owner';
      ensureConfiguredAgent(settings, {
        agentId: folder,
        agentName: 'Approver Test',
        agentFolder: folder,
      });
      settings.providers.teams.enabled = true;
      settings.providerAccounts[accountId] = {
        agentId: folder,
        provider: 'teams',
        label: 'Fresh Teams',
        runtimeSecretRefs: {},
      };
      const desired = new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
        clock: { now: () => NOW },
      });
      await desired.reconcile(settings);
      const conversation = {
        id: `conversation:${accountId}:19:test@thread.tacv2` as never,
        appId: APP_ID,
        providerAccountId: accountId as never,
        externalRef: {
          kind: 'conversation' as const,
          value: '19:test@thread.tacv2',
        },
        kind: 'channel' as const,
        title: 'Fresh Team / Testing',
        status: 'active' as const,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await runtime.repositories.conversations.saveConversation(conversation);
      const people = new PersonIdentityService(
        new PostgresPersonIdentityRepository(runtime.service.db),
      );
      const admin = new ConversationAdministrationService(
        runtime.repositories,
        {
          validateControlApprovers: async ({ userIds }) => ({
            validUserIds: userIds.filter((id) => id === ownerId),
            invalidUserIds: userIds.filter((id) => id !== ownerId),
          }),
        },
        (input, auditEventFactory) => people.resolve(input, auditEventFactory),
      );
      const request = {
        appId: APP_ID,
        conversationId: conversation.id,
        userIds: [ownerId],
        updatedAt: NOW,
      };
      await expect(
        admin.replaceControlAllowlist({ ...request, userIds: ['outsider'] }),
      ).rejects.toThrow('Control approvers must be members');
      await expect(
        people.resolve({
          appId: APP_ID,
          provider: 'teams',
          providerAccountId: accountId,
          externalUserId: 'outsider',
          evidenceType: 'provider_user',
          createIfMissing: false,
        }),
      ).resolves.toMatchObject({ status: 'unresolved', personId: null });
      await expect(admin.replaceControlAllowlist(request)).resolves.toEqual({
        userIds: [ownerId],
      });
      const principal =
        await runtime.repositories.conversations.resolveConversationApproverPrincipal(
          {
            appId: APP_ID,
            conversationId: conversation.id,
            externalUserId: ownerId,
          },
        );
      expect(principal?.personId).toBeTruthy();
      await expect(
        runtime.repositories.conversations.listParticipantExternalUserIds(
          conversation.id,
        ),
      ).resolves.toEqual([]);
      applyConversationInstallToSettings({
        settings,
        conversation,
        providerAccountId: accountId,
        agentFolder: folder,
        controlApprovers: [ownerId],
        now: NOW,
      });
      const projected = parseRuntimeSettings(
        renderRuntimeSettingsYaml(settings),
      );
      const replay = await desired.reconcile(projected);
      expect(
        replay.skipped.filter((reason) =>
          reason.includes('conversation_approvers:'),
        ),
      ).toEqual([]);
      await expect(
        admin.getAdminSummary({
          appId: APP_ID,
          conversationId: conversation.id,
        }),
      ).resolves.toEqual({ controlAllowlist: { userIds: [ownerId] } });
      const selected =
        projected.conversations[Object.keys(projected.conversations)[0]!];
      selected.controlApprovers = ['outsider'];
      const deniedReplay = await desired.reconcile(projected);
      expect(
        deniedReplay.skipped.some((reason) =>
          reason.includes('Control approvers must be members'),
        ),
      ).toBe(true);
      await expect(
        admin.getAdminSummary({
          appId: APP_ID,
          conversationId: conversation.id,
        }),
      ).resolves.toEqual({ controlAllowlist: { userIds: [ownerId] } });
    });
    it('saves and lists a conversation installation through the authenticated browser dispatcher', async () => {
      const settings = createDefaultRuntimeSettings();
      const folder = 'browser_install_agent';
      const accountId = 'browser_teams_account';
      const agentId = `agent:${folder}` as never;
      ensureConfiguredAgent(settings, {
        agentId: folder,
        agentName: 'Browser Install Test',
        agentFolder: folder,
      });
      settings.providers.teams.enabled = true;
      settings.providerAccounts[accountId] = {
        agentId: folder,
        provider: 'teams',
        label: 'Browser Teams',
        runtimeSecretRefs: {},
      };
      await new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
        clock: { now: () => NOW },
      }).reconcile(settings);
      const conversationId =
        `conversation:${accountId}:19:browser@thread.tacv2` as never;
      await runtime.repositories.conversations.saveConversation({
        id: conversationId,
        appId: APP_ID,
        providerAccountId: accountId as never,
        externalRef: { kind: 'conversation', value: '19:browser@thread.tacv2' },
        kind: 'channel',
        title: 'Browser Team / Testing',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const versionId = 'config:browser-selected:2' as never;
      await runtime.repositories.agentConfigs.saveConfigVersion({
        id: versionId,
        appId: APP_ID,
        agentId,
        version: 2,
        promptProfileRef: 'default',
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        modelAliasSnapshot: 'test-small-model',
        roleSnapshot: { displayName: 'Test helper', prompt: 'Answer briefly.' },
        toolIds: [],
        skillIds: [],
        permissionPolicyIds: [],
        createdAt: NOW,
      });
      const selectedAgent = await runtime.repositories.agents.getAgent(agentId);
      await runtime.repositories.agents.saveAgent({
        ...selectedAgent!,
        currentConfigVersionId: versionId,
      });
      _setRuntimeStorageForTest(runtime.storageRuntime);
      const authentication = new PostgresAuthenticationRepository(
        runtime.service.db,
      );
      const now = new Date().toISOString();
      const userId = await authentication.ensureLocalAdministrator(APP_ID, now);
      const token = 'browser-install-session';
      const csrf = 'browser-install-csrf';
      const expires = new Date(Date.now() + 60_000).toISOString();
      await authentication.createBrowserSession({
        appId: APP_ID,
        userId,
        sessionHash: hashAuthToken(token),
        csrfHash: hashAuthToken(csrf),
        idleExpiresAt: expires,
        absoluteExpiresAt: expires,
        now,
      });
      let projections = 0;
      const desired = new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
        clock: { now: () => NOW },
      });
      const ctx = {
        syncSettingsFromProjection: async () => {
          projections += 1;
          let projected = settings;
          for (let replay = 0; replay < 2; replay += 1) {
            projected = parseRuntimeSettings(
              renderRuntimeSettingsYaml(await desired.exportCurrent(projected)),
            );
            await desired.reconcile(projected);
          }
        },
      } as unknown as ControlRouteContext;
      const server = createServer((req, res) => {
        const url = new URL(req.url!, settings.authentication.canonicalOrigin);
        void handleBrowserControlRoutes({
          req,
          res,
          ctx,
          url,
          pathname: url.pathname,
          getSettings: () => settings,
        })
          .then((handled) => {
            if (!handled) {
              res.statusCode = 404;
              res.end();
            }
          })
          .catch((error: unknown) => {
            res.statusCode = 500;
            res.end(String(error));
          });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing test server address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      settings.authentication.canonicalOrigin = baseUrl;
      const listPath = `/ui/api/agents/${encodeURIComponent(agentId)}/conversation-installs`;
      const installPath = `${listPath}/${encodeURIComponent(conversationId)}`;
      const headers = {
        cookie: `gantry_session=${token}`,
        origin: baseUrl,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      };
      const body = JSON.stringify({
        providerAccountId: accountId,
        memoryScope: 'conversation',
      });
      try {
        const rejected = await fetch(`${baseUrl}${installPath}`, {
          method: 'PUT',
          headers: { ...headers, 'x-csrf-token': 'invalid' },
          body,
        });
        expect(rejected.status).toBe(403);
        await expect(
          runtime.repositories.providerAccounts.getConversationInstall({
            appId: APP_ID,
            agentId,
            conversationId,
          }),
        ).resolves.toBeNull();
        const saved = await fetch(`${baseUrl}${installPath}`, {
          method: 'PUT',
          headers,
          body,
        });
        expect(saved.status, await saved.clone().text()).toBe(201);
        expect(await saved.json()).toMatchObject({
          install: {
            agentId,
            conversationId,
            providerAccountId: accountId,
            status: 'active',
            memoryScope: 'conversation',
          },
        });
        await expect(
          runtime.repositories.providerAccounts.getConversationInstall({
            appId: APP_ID,
            agentId,
            conversationId,
          }),
        ).resolves.toMatchObject({
          status: 'active',
          providerAccountId: accountId,
        });
        expect(projections).toBe(1);
        await expect(
          runtime.repositories.agents.getAgent(agentId),
        ).resolves.toMatchObject({ currentConfigVersionId: versionId });
        await expect(
          runtime.repositories.conversations.getConversation(conversationId),
        ).resolves.toMatchObject({ kind: 'channel' });
        const sameChannel = (
          await runtime.repositories.conversations.listConversations({
            appId: APP_ID,
          })
        ).filter(
          (c) =>
            c.providerAccountId === accountId &&
            c.externalRef.value === '19:browser@thread.tacv2',
        );
        expect(sameChannel).toHaveLength(1);
        const activeInstalls = (
          await runtime.repositories.providerAccounts.listConversationInstalls(
            APP_ID,
            agentId,
          )
        ).filter((i) => i.status === 'active');
        expect(activeInstalls).toHaveLength(1);
        expect(activeInstalls[0]?.conversationId).toBe(conversationId);
        const sessionId = 'session:browser-first-message' as never;
        await runtime.repositories.agentSessions.saveAgentSession({
          id: sessionId,
          appId: APP_ID,
          agentId,
          conversationId,
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        });
        const runId = await runtime.ops.createSessionAgentRun({
          agentSessionId: sessionId,
          executionProviderId: 'deepagents:langchain',
          cause: 'message',
        });
        expect(runId).toBeTruthy();
        await expect(
          runtime.repositories.agentRuns.getAgentRun(runId as never),
        ).resolves.toMatchObject({
          configVersionId: versionId,
          llmProfileId: DEFAULT_LLM_PROFILE_ID,
        });
        const listed = await fetch(`${baseUrl}${listPath}`, { headers });
        expect(listed.status).toBe(200);
        expect(await listed.json()).toMatchObject({
          installs: [
            { conversationId, providerAccountId: accountId, status: 'active' },
          ],
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
);

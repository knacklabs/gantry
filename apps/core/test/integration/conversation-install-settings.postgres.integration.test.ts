import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'conversation_install_settings',
      });
    }, 60_000);

    afterAll(async () => {
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
  },
);

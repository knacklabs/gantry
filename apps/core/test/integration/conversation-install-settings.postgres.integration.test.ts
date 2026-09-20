import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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
      const service = new SettingsDesiredStateService({
        ops: runtime.ops,
        repositories: runtime.repositories,
        clock: { now: () => NOW },
      });
      const result = await service.reconcile(settings);

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

      await service.reconcile(settings);
      await expect(
        runtime.repositories.providerAccounts.listConversationInstalls(
          APP_ID,
          `agent:${AGENT_FOLDER}` as never,
        ),
      ).resolves.toHaveLength(1);

      const install = (
        await runtime.repositories.providerAccounts.listConversationInstalls(
          APP_ID,
          `agent:${AGENT_FOLDER}` as never,
        )
      )[0]!;
      await runtime.service.pool.query(
        'DROP INDEX "uniq_conversation_installs_control_scope"',
      );
      await runtime.service.pool.query(
        `INSERT INTO conversation_installs (
          id, app_id, agent_id, provider_account_id, conversation_id, thread_id,
          display_name, status, sender_policy, control_policy, memory_scope,
          memory_subject_json, workspace_snapshot_id, permission_policy_ids_json,
          created_at, updated_at
        )
        SELECT $1, app_id, agent_id, provider_account_id, conversation_id, thread_id,
          'Legacy duplicate', status, sender_policy, control_policy, memory_scope,
          '{"kind":"conversation"}', workspace_snapshot_id, '["permission:test"]',
          created_at, updated_at + interval '1 second'
        FROM conversation_installs WHERE id = $2`,
        ['conversation-install:legacy-duplicate', install.id],
      );
      const migration = readFileSync(
        new URL(
          '../../src/adapters/storage/postgres/schema/migrations/20260920062806_canonical_conversation_install_scope.sql',
          import.meta.url,
        ),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await runtime.service.pool.query(statement);
      }
      const canonicalRows = await runtime.service.pool.query<{
        id: string;
        display_name: string;
        memory_subject_json: string;
        permission_policy_ids_json: string;
      }>(
        `SELECT id, display_name, memory_subject_json, permission_policy_ids_json
         FROM conversation_installs
         WHERE app_id = $1 AND agent_id = $2 AND conversation_id = $3
           AND id NOT LIKE 'conversation-route:%'`,
        [APP_ID, `agent:${AGENT_FOLDER}`, conversation!.id],
      );
      expect(canonicalRows.rows).toHaveLength(1);
      expect(canonicalRows.rows[0]!.display_name).toBe('Legacy duplicate');
      expect(
        JSON.parse(canonicalRows.rows[0]!.memory_subject_json),
      ).toHaveProperty('route');
      expect(
        JSON.parse(canonicalRows.rows[0]!.permission_policy_ids_json),
      ).toContain('permission:test');

      await runtime.repositories.providerAccounts.saveProviderAccount({
        ...(await runtime.repositories.providerAccounts.getProviderAccount(
          PROVIDER_ACCOUNT_ID as never,
        ))!,
        id: `${PROVIDER_ACCOUNT_ID}_conflict` as never,
        externalIdentityRef: {
          kind: 'provider_account',
          value: 'T-conflict',
        },
      });
      await runtime.service.pool.query(
        'DROP INDEX "uniq_conversation_installs_control_scope"',
      );
      await runtime.service.pool.query(
        `INSERT INTO conversation_installs (
           id, app_id, agent_id, provider_account_id, conversation_id, thread_id,
           display_name, status, sender_policy, control_policy, memory_scope,
           memory_subject_json, workspace_snapshot_id, permission_policy_ids_json,
           created_at, updated_at
         )
         SELECT $1, app_id, agent_id, $2, conversation_id, thread_id,
           display_name, status, sender_policy, control_policy, memory_scope,
           memory_subject_json, workspace_snapshot_id, permission_policy_ids_json,
           created_at, updated_at
         FROM conversation_installs WHERE id = $3`,
        [
          'conversation-install:provider-conflict',
          `${PROVIDER_ACCOUNT_ID}_conflict`,
          canonicalRows.rows[0]!.id,
        ],
      );
      await expect(
        runtime.service.pool.query(
          migration.split('--> statement-breakpoint')[0]!,
        ),
      ).rejects.toThrow('Conflicting conversation installs');
    });
  },
);

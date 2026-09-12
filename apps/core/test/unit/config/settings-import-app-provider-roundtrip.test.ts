import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import {
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';
import { validateLoadedRuntimeSettings } from '@core/config/settings/runtime-settings-validation.js';
import { exportCurrentDesiredState } from '@core/config/settings/desired-state-current-export.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

describe('settings revision app-provider round-trip', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('preserves the provider account used by an installed agent', () => {
    vi.stubEnv(
      'GANTRY_DATABASE_URL',
      'postgres://gantry:gantry@localhost:5432/gantry_test',
    );
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.from(
        '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
        'hex',
      ).toString('base64'),
    );
    const settings = createDefaultRuntimeSettings();
    const agentId = 'app_27224fa60440_default_codex_test_20260604025232';
    const accountId = `app_${agentId}`;
    const conversationId = `${agentId}_app`;
    settings.providers.app = { enabled: true };
    settings.agents[agentId] = {
      name: 'Codex Test',
      folder: agentId,
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.providerAccounts[accountId] = {
      agentId,
      provider: 'app',
      label: 'Codex Test',
      runtimeSecretRefs: {},
    };
    settings.conversations[conversationId] = {
      providerAccount: accountId,
      externalId: 'default:codex-test-20260604025232',
      kind: 'group',
      displayName: 'Codex Test',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {
        [agentId]: {
          agentId,
          providerAccountId: accountId,
          status: 'active',
          addedAt: new Date(0).toISOString(),
          memoryScope: 'conversation',
        },
      },
    };
    settings.authentication = {
      mode: 'hosted',
      canonicalOrigin: 'https://console.example.com',
      activeOidc: {
        issuer: 'https://accounts.google.com',
        clientId: 'gantry-console',
        clientSecretRef: 'env:GOOGLE_OIDC_CLIENT_SECRET',
        companyDomain: 'example.com',
        providerLabel: 'Google',
      },
      candidateOidc: {
        issuer: 'https://login.example.com',
        clientId: 'candidate-console',
        clientSecretRef: 'env:CANDIDATE_OIDC_SECRET',
        companyDomain: 'example.com',
        providerLabel: 'Example SSO',
      },
    };

    const restored = settingsFromRevisionDocument(
      settingsToRevisionDocument(settings),
    );

    expect(restored.conversations[conversationId]).toMatchObject({
      providerAccount: accountId,
      installedAgents: {
        [agentId]: { providerAccountId: accountId },
      },
    });
    expect(restored.authentication).toEqual(settings.authentication);
    const validation = validateLoadedRuntimeSettings(
      '/tmp/gantry-settings-roundtrip',
      restored,
    );
    expect(validation.failure?.details ?? []).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('round-trips provider_session_max_input_tokens through the revision document and the export', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.limits.providerSessionMaxInputTokens = 275_000;

    const document = settingsToRevisionDocument(settings);
    const restored = settingsFromRevisionDocument(document);
    const exported = await exportCurrentDesiredState({
      appId: 'default' as never,
      settings: restored,
      deps: {
        ops: { getAllConversationRoutes: async () => ({}) },
        repositories: {
          agents: { listAgents: async () => [] },
          tools: {
            listAgentToolBindingsForAgents: async () => [],
            listTools: async () => [],
          },
          skills: {
            listAgentSkillBindingsForAgents: async () => [],
            listSkills: async () => [],
          },
          mcpServers: { listAgentBindingsForAgents: async () => [] },
        },
      } as never,
    });

    expect(document.limits).toMatchObject({
      provider_session_max_input_tokens: 275_000,
    });
    expect(restored.limits.providerSessionMaxInputTokens).toBe(275_000);
    expect(exported.limits.providerSessionMaxInputTokens).toBe(275_000);
  });

  it('emits the limits block for a cap configured with no provider entries', () => {
    const settings = createDefaultRuntimeSettings();
    settings.limits.providerSessionMaxInputTokens = 325_000;

    const yaml = renderRuntimeSettingsYaml(settings);

    expect(yaml).toContain(
      'limits:\n  provider_session_max_input_tokens: 325000',
    );
  });
});

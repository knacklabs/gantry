import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import {
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';
import { validateLoadedRuntimeSettings } from '@core/config/settings/runtime-settings-validation.js';

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
      providerConnection: accountId,
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

    const restored = settingsFromRevisionDocument(
      settingsToRevisionDocument(settings),
    );

    expect(restored.conversations[conversationId]).toMatchObject({
      providerAccount: accountId,
      installedAgents: {
        [agentId]: { providerAccountId: accountId },
      },
    });
    const validation = validateLoadedRuntimeSettings(
      '/tmp/gantry-settings-roundtrip',
      restored,
    );
    expect(validation.failure?.details ?? []).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

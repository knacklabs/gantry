import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import {
  SettingsRevisionConflictError,
  SettingsStaleMutationError,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';
import type { EffectiveControlRuntimeSettings } from '@core/application/control-plane/control-plane-storage-model.js';

const state = vi.hoisted(() => ({ settings: null as any }));
const importWorkstation = vi.hoisted(() => vi.fn());
const importFleet = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({
  ops: {},
  repositories: { settingsRevisions: {} },
  service: { pool: {} },
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => storage,
  getRuntimeBrowserProfileArtifactStore: () => ({}),
  getRuntimeBrowserProfileSnapshotRepository: () => ({}),
}));

vi.mock('@core/config/index.js', async () => {
  const actual = await vi.importActual<typeof import('@core/config/index.js')>(
    '@core/config/index.js',
  );
  return {
    ...actual,
    getRuntimeSettingsForConfig: () => state.settings,
    loadRuntimeSettings: () => state.settings,
  };
});

vi.mock('@core/config/settings/settings-import-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/config/settings/settings-import-service.js')
  >('@core/config/settings/settings-import-service.js');
  return {
    ...actual,
    importWorkstationSettings: importWorkstation,
    importFleetSettingsRevision: importFleet,
  };
});

import {
  createControlAgentSettingsPort,
  createControlSettingsImportPort,
} from '@core/app/bootstrap/fleet-boot.js';
import { createResolveObserverStatus } from '@core/application/control-plane/control-plane-storage-model.js';

beforeEach(() => {
  state.settings = createDefaultRuntimeSettings();
  importWorkstation.mockReset();
  importFleet.mockReset();
});

describe('control route port composition', () => {
  it('decodes and serializes the narrow agent view and writes harness settings', async () => {
    const port = createControlAgentSettingsPort();
    state.settings.agents.worker = {
      name: 'Worker',
      folder: 'worker',
      persona: 'developer',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    const document = settingsToRevisionDocument(state.settings);

    expect(port.decodeRevisionDocument(document).agents.worker?.persona).toBe(
      'developer',
    );
    expect(
      port.serializeRevisionDocument(port.decodeRevisionDocument(document)),
    ).toEqual(document);

    importWorkstation.mockResolvedValue({
      status: 'revision_created',
      revision: 2,
    });
    await port.writeAgentHarnessSetting({
      runtimeHome: '/tmp/gantry-test',
      appId: 'default' as never,
      folder: 'worker',
      name: 'Worker Two',
      agentHarness: 'deepagents',
    });

    expect(importWorkstation).toHaveBeenCalledOnce();
    expect(importWorkstation.mock.calls[0]?.[1].agents.worker).toMatchObject({
      name: 'Worker Two',
      agentHarness: 'deepagents',
    });
    expect(importWorkstation.mock.calls[0]?.[0]).toMatchObject({
      runtimeHome: '/tmp/gantry-test',
      appId: 'default',
      revisionMirrorRequired: true,
      revisionMirror: { createdBy: 'control-api:agent-harness' },
    });
  });

  it('adapts desired-state imports and classifies their concurrency errors', async () => {
    const port = createControlSettingsImportPort();
    importWorkstation.mockResolvedValue({ status: 'no_op' });
    importFleet.mockResolvedValue({ status: 'applied', revision: 4 });

    await expect(port.importWorkstation({}, state.settings)).resolves.toEqual({
      status: 'no_op',
    });
    await expect(
      port.importFleet({}, state.settings, { expectedRevision: 3 }),
    ).resolves.toEqual({ status: 'applied', revision: 4 });
    expect(port.classifyImportError(new SettingsStaleMutationError())).toEqual({
      kind: 'stale',
    });
    expect(
      port.classifyImportError(
        new SettingsRevisionConflictError({
          expectedRevision: 3,
          actualRevision: 4,
        }),
      ),
    ).toEqual({ kind: 'conflict', expectedRevision: 3, actualRevision: 4 });
  });

  it('resolves neutral observer status from effective settings and durable ownership', async () => {
    state.settings.observer = {
      enabled: true,
      owner: { recipient: 'user-1', conversation: 'owner_dm' },
    };
    state.settings.providers.chat_provider = { enabled: true };
    state.settings.providerAccounts.account_1 = {
      agentId: 'main',
      provider: 'chat_provider',
      label: 'Chat',
      runtimeSecretRefs: {},
    };
    state.settings.conversations.owner_dm = {
      providerAccount: 'account_1',
      externalId: 'cp:room-1',
      kind: 'dm',
      displayName: 'Owner',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['user-1'],
      installedAgents: {},
    };
    const conversations = {
      getConversationByExternalRef: vi.fn(async () => ({
        id: 'conversation:account_1:cp:room-1',
        kind: 'direct',
      })),
      listParticipantExternalUserIds: vi.fn(async () => ['user-1']),
      listConversationApprovers: vi.fn(async () => [
        { externalUserId: 'user-1' },
      ]),
    } as any;
    const settings = state.settings as EffectiveControlRuntimeSettings;
    const resolveStatus = createResolveObserverStatus({
      getEffectiveRuntimeSettings: () => settings,
      getInternalRuntimeSettings: () => settings,
      getEffectiveMemoryState: () => ({
        enabled: true,
        dreamingEnabled: true,
      }),
      conversations,
    });

    await expect(resolveStatus('default' as never)).resolves.toEqual({
      enabled: true,
      activation: 'active',
      message: 'Observer is active.',
      dreamingEnabled: true,
      owner: {
        recipient: 'user-1',
        conversation: 'owner_dm',
        conversationJid: 'cp:room-1',
        providerAccountId: 'account_1',
      },
    });
    expect(conversations.getConversationByExternalRef).toHaveBeenCalledWith({
      appId: 'default',
      providerId: 'chat_provider',
      providerAccountId: 'account_1',
      externalConversationId: 'cp:room-1',
    });
  });
});

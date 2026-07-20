import { describe, expect, it, vi } from 'vitest';

import {
  classifySettingsChanges,
  SettingsDesiredStateService,
} from '@core/application/settings/desired-state-service.js';
import { configuredRoutingBindings } from '@core/application/settings/desired-state-service-helpers.js';
import {
  createDefaultRuntimeSettings,
  ensureConfiguredConversationBinding,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import {
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';

function settingsWithInstall(status: 'active' | 'disabled' = 'active') {
  const settings = createDefaultRuntimeSettings();
  settings.providers.slack = { enabled: true };
  settings.providerAccounts.slack_one = {
    agentId: 'main_agent',
    provider: 'slack',
    label: 'Slack',
    runtimeSecretRefs: {},
  };
  settings.agents.main_agent = {
    name: 'Main',
    folder: 'main_agent',
    delegates: [],
    sources: { skills: [], mcpServers: [], tools: [] },
    capabilities: [],
    accessPreset: 'full',
  };
  settings.conversations.sales = {
    providerAccount: 'slack_one',
    externalId: 'C123',
    kind: 'channel',
    displayName: 'Sales',
    brainHarvest: false,
    requiresTrigger: true,
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: [],
    installedAgents: {
      main_agent: {
        agentId: 'main_agent',
        providerAccountId: 'slack_one',
        threadId: '171.222',
        status,
        addedAt: '2026-06-01T00:00:00.000Z',
        memoryScope: 'user',
        model: 'anthropic/claude-opus-4-6',
        permissionMode: 'ask',
      },
    },
  };
  return settings;
}

function makeReconcileHarness(existingConversation?: object) {
  const saveConversation = vi.fn(async (_conversation: unknown) => undefined);
  const setConversationRoute = vi.fn(async () => undefined);
  const persistedConversationInstalls = new Map<string, unknown>();
  const saveConversationInstall = vi.fn(async (install: unknown) => {
    const persistedInstall = install as { id: string };
    persistedConversationInstalls.set(persistedInstall.id, persistedInstall);
  });
  const service = new SettingsDesiredStateService({
    ops: {
      getAllConversationRoutes: vi.fn(async () => ({})),
      setConversationRoute,
    },
    repositories: {
      agents: {
        saveAgent: vi.fn(async () => undefined),
      },
      tools: {
        listTools: vi.fn(async () => []),
      },
      skills: {
        listSkills: vi.fn(async () => []),
      },
      mcpServers: {
        getServer: vi.fn(async () => null),
      },
      providerAccounts: {
        getProviderAccount: vi.fn(async () => null),
        saveProviderAccount: vi.fn(async () => undefined),
        saveConversationInstall,
      },
      conversations: {
        getConversationByExternalRef: vi.fn(
          async () => existingConversation ?? null,
        ),
        saveConversation,
        saveThread: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
    },
    clock: { now: () => '2026-06-01T00:00:00.000Z' },
  } as never);
  return {
    persistedConversationInstalls,
    saveConversation,
    saveConversationInstall,
    setConversationRoute,
    service,
  };
}

describe('desired-state settings projection', () => {
  it('inherits the conversation provider account for a nested install', () => {
    const settings = settingsWithInstall();
    settings.conversations.sales.installedAgents.main_agent.providerAccountId =
      undefined;

    expect(configuredRoutingBindings(settings)).toEqual([
      expect.objectContaining({
        agentFolder: 'main_agent',
        conversationId: 'sales',
        providerAccountId: 'slack_one',
        threadId: '171.222',
        requiresTrigger: true,
        memoryScope: 'user',
        model: 'anthropic/claude-opus-4-6',
        permissionMode: 'ask',
      }),
    ]);
  });

  it('drops install trigger while preserving conversation trigger policy through round-trip', async () => {
    const settings = createDefaultRuntimeSettings();
    ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Main',
      agentFolder: 'main_agent',
      jid: 'sl:C123',
      displayName: 'Sales',
      trigger: '@Main',
      ['requires' + 'Trigger']: true,
    });
    const revisionRoundTrip = settingsFromRevisionDocument(
      settingsToRevisionDocument(settings),
    );
    expect(
      revisionRoundTrip.conversations.slack_default_c123.installedAgents
        .main_agent.trigger,
    ).toBeUndefined();
    expect(
      revisionRoundTrip.conversations.slack_default_c123.requiresTrigger,
    ).toBe(true);
    const reconciledSettings = parseRuntimeSettings(
      renderRuntimeSettingsYaml(revisionRoundTrip),
    );
    const {
      saveConversation,
      saveConversationInstall,
      service,
      setConversationRoute,
    } = makeReconcileHarness();

    await service.reconcile(reconciledSettings);

    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({ requiresTrigger: true }),
    );
    const persistedInstall = saveConversationInstall.mock.calls[0]?.[0] as {
      memorySubject: { route?: object };
    };
    expect(persistedInstall.memorySubject.route).not.toHaveProperty(
      'requiresTrigger',
    );
    expect(persistedInstall.memorySubject.route).not.toHaveProperty('trigger');
    expect(setConversationRoute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requiresTrigger: true }),
    );
  });

  it('does not route disabled nested installs', () => {
    expect(configuredRoutingBindings(settingsWithInstall('disabled'))).toEqual(
      [],
    );
  });

  it('rejects duplicate active installs that resolve to the same runtime route', () => {
    const settings = settingsWithInstall();
    const install = settings.conversations.sales.installedAgents.main_agent;
    install.providerAccountId = undefined;
    settings.conversations.sales.installedAgents.duplicate = {
      ...install,
      providerAccountId: 'slack_one',
    };

    expect(() => configuredRoutingBindings(settings)).toThrow(
      /Duplicate active conversation installs sales\.main_agent and sales\.duplicate resolve to the same runtime route/,
    );
  });

  it('does not expose duplicate binding projections', () => {
    const settings = settingsWithInstall();
    expect(settings).not.toHaveProperty('bindings');
    expect(settings).not.toHaveProperty('conversationInstalls');
    expect(settings.agents.main_agent).not.toHaveProperty('bindings');
  });

  it('classifies conversation topology changes as live-applied', () => {
    const previous = settingsWithInstall();
    const next = structuredClone(previous);
    next.conversations.sales.requiresTrigger = false;
    expect(classifySettingsChanges(previous, next)).toEqual(
      expect.objectContaining({
        liveApplied: expect.arrayContaining(['conversation_policies']),
      }),
    );
  });

  it('scopes conversation-install IDs to conversations when install keys repeat', async () => {
    const settings = settingsWithInstall();
    settings.conversations.support = {
      ...structuredClone(settings.conversations.sales),
      externalId: 'C456',
      displayName: 'Support',
    };
    const { saveConversationInstall, service } = makeReconcileHarness();

    await service.reconcile(settings);

    const installs = saveConversationInstall.mock.calls.map(
      ([install]) => install as { conversationId: string; id: string },
    );
    expect(installs).toHaveLength(2);
    expect(new Set(installs.map((install) => install.id))).toEqual(
      new Set([
        'agent-conversation-binding:sales:main_agent:main_agent',
        'agent-conversation-binding:support:main_agent:main_agent',
      ]),
    );
  });

  it('keeps a conversation-install ID when its external target changes', async () => {
    const settings = settingsWithInstall();
    const { persistedConversationInstalls, saveConversationInstall, service } =
      makeReconcileHarness();

    await service.reconcile(settings);
    settings.conversations.sales.externalId = 'C456';
    await service.reconcile(settings);

    const installs = saveConversationInstall.mock.calls.map(
      ([install]) => install as { conversationId: string; id: string },
    );
    expect(installs).toHaveLength(2);
    expect(installs[1]?.id).toBe(installs[0]?.id);
    expect(installs[1]?.conversationId).not.toBe(installs[0]?.conversationId);
    expect(persistedConversationInstalls.size).toBe(1);
    expect(persistedConversationInstalls.get(installs[0]!.id)).toMatchObject({
      conversationId: installs[1]?.conversationId,
    });
  });

  it('persists a requiresTrigger-only conversation change', async () => {
    const settings = settingsWithInstall();
    const existingConversation = {
      id: 'conversation:slack_one:sl:C123',
      appId: 'default',
      providerAccountId: 'slack_one',
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'Sales',
      requiresTrigger: false,
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const { saveConversation, service } =
      makeReconcileHarness(existingConversation);

    await service.reconcile(settings);

    expect(saveConversation).toHaveBeenCalledWith({
      ...existingConversation,
      requiresTrigger: true,
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
  });
});

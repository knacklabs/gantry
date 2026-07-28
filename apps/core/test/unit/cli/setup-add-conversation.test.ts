import { afterEach, describe, expect, it, vi } from 'vitest';

function createSettings() {
  return {
    providers: { slack: { enabled: true } },
    providerAccounts: {
      slack_ops: {
        agentId: 'main_agent',
        provider: 'slack',
        label: 'Slack Ops',
        runtimeSecretRefs: {
          bot_token: 'gantry-secret:MAIN_SLACK_BOT_TOKEN',
          app_token: 'gantry-secret:MAIN_SLACK_APP_TOKEN',
        },
      },
    },
    agents: {
      main_agent: {
        name: 'Ops',
        folder: 'main_agent',
      },
    },
    conversations: {},
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/channels/control-provider-catalog.js');
  vi.doUnmock('@core/channels/conversation-membership-validation.js');
  vi.doUnmock('@core/channels/provider-registry.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/cli/runtime-group-db.js');
});

function mockPrompts(options: { confirmSave?: boolean } = {}) {
  const select = vi.fn(async ({ message }: { message: string }) => {
    if (message === 'Choose an existing agent') return 'main_agent';
    if (message === 'Choose the Provider Account to reuse') return 'slack_ops';
    if (message === 'Choose a conversation to install') return 'C12345678';
    if (message === 'Sender policy') return 'all';
    if (message === 'Memory scope') return 'conversation';
    return '__cancel';
  });
  const text = vi.fn(async ({ message }: { message: string }) => {
    if (message === 'Conversation display name') return 'incident-room';
    if (message.startsWith('Conversation approver')) return 'U12345678';
    if (message === 'Trigger phrase') return '@Ops';
    return '';
  });
  const confirm = vi.fn(async ({ message }: { message: string }) => {
    if (message === 'Save this conversation install?') {
      return options.confirmSave ?? true;
    }
    return true;
  });
  const note = vi.fn();
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    select,
    text,
    confirm,
    note,
    log,
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
  }));
  return { select, text, confirm, note, log };
}

function mockProviderValidation() {
  vi.doMock('@core/channels/provider-registry.js', () => ({
    getProvider: () => ({
      id: 'slack',
      label: 'Slack',
      jidPrefix: 'sl:',
    }),
    listConnectableChannelProviders: () => [
      {
        id: 'slack',
        label: 'Slack',
        jidPrefix: 'sl:',
      },
    ],
    providerJidPrefix: () => 'sl:',
  }));
  vi.doMock('@core/channels/control-provider-catalog.js', () => ({
    RuntimeSecretConversationDiscovery: class {
      async discover() {
        return [
          {
            externalId: 'C12345678',
            title: 'incident-room',
            kind: 'channel',
          },
        ];
      }
    },
  }));
  vi.doMock('@core/channels/conversation-membership-validation.js', () => ({
    RuntimeSecretConversationMembershipValidator: class {
      async validateControlApprovers(input: { userIds: string[] }) {
        return {
          validUserIds: input.userIds,
          invalidUserIds: [],
        };
      }
    },
  }));
}

async function setupDependencies(
  settings: ReturnType<typeof createSettings>,
  writeSettings: ReturnType<typeof vi.fn>,
  noteRestartRequired = vi.fn(),
) {
  const helpers =
    await import('@core/config/settings/conversation-install-settings.js');
  return {
    loadSettings: vi.fn(async () => settings),
    writeSettings,
    noteRestartRequired,
    hasConversationInstallInSettings: helpers.hasConversationInstallInSettings,
    applyConversationInstallToSettings:
      helpers.applyConversationInstallToSettings,
  };
}

describe('add conversation to existing agent setup slice', () => {
  it('writes one additive install and preserves provider secret refs', async () => {
    const settings = createSettings();
    const refsBefore = structuredClone(
      settings.providerAccounts.slack_ops.runtimeSecretRefs,
    );
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
      restartRequired: ['conversations'],
    }));
    const noteRestartRequired = vi.fn();
    mockPrompts();
    mockProviderValidation();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
      writeDesiredRuntimeSettings,
      noteRestartRequired,
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getRuntimeSecrets: () => ({ get: vi.fn() }),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { runAddConversationSetupSlice } =
      await import('@core/cli/setup-add-conversation.js');
    const code = await runAddConversationSetupSlice(
      '/tmp/gantry',
      await setupDependencies(
        settings,
        writeDesiredRuntimeSettings,
        noteRestartRequired,
      ),
    );

    expect(code).toBe(0);
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledTimes(1);
    const write = writeDesiredRuntimeSettings.mock.calls[0]![0];
    expect(write.settings.providerAccounts.slack_ops.runtimeSecretRefs).toEqual(
      refsBefore,
    );
    expect(write.previousSettings).toBe(settings);
    const conversation = Object.values(write.settings.conversations)[0] as any;
    expect(conversation).toMatchObject({
      providerAccount: 'slack_ops',
      externalId: 'C12345678',
      controlApprovers: ['U12345678'],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack_ops',
          trigger: '@Ops',
          requiresTrigger: true,
          memoryScope: 'conversation',
        },
      },
    });
    expect(noteRestartRequired).toHaveBeenCalledWith(
      expect.objectContaining({ restartRequired: ['conversations'] }),
    );
  });

  it('does not write when final confirmation is declined', async () => {
    const settings = createSettings();
    const writeDesiredRuntimeSettings = vi.fn();
    mockPrompts({ confirmSave: false });
    mockProviderValidation();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
      writeDesiredRuntimeSettings,
      noteRestartRequired: vi.fn(),
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getRuntimeSecrets: () => ({ get: vi.fn() }),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { runAddConversationSetupSlice } =
      await import('@core/cli/setup-add-conversation.js');
    const code = await runAddConversationSetupSlice(
      '/tmp/gantry',
      await setupDependencies(settings, writeDesiredRuntimeSettings),
    );

    expect(code).toBe(1);
    expect(writeDesiredRuntimeSettings).not.toHaveBeenCalled();
    expect(settings.conversations).toEqual({});
  });

  it('rejects an existing exact install before collecting route policy', async () => {
    const settings = createSettings();
    settings.conversations.slack_ops_c12345678 = {
      providerAccount: 'slack_ops',
      externalId: 'C12345678',
      kind: 'channel',
      displayName: 'incident-room',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['U12345678'],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack_ops',
          status: 'active',
          addedAt: '2026-07-28T00:00:00.000Z',
          memoryScope: 'conversation',
        },
      },
    };
    const writeDesiredRuntimeSettings = vi.fn();
    const prompts = mockPrompts();
    mockProviderValidation();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
      writeDesiredRuntimeSettings,
      noteRestartRequired: vi.fn(),
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getRuntimeSecrets: () => ({ get: vi.fn() }),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { runAddConversationSetupSlice } =
      await import('@core/cli/setup-add-conversation.js');
    const code = await runAddConversationSetupSlice(
      '/tmp/gantry',
      await setupDependencies(settings, writeDesiredRuntimeSettings),
    );

    expect(code).toBe(1);
    expect(writeDesiredRuntimeSettings).not.toHaveBeenCalled();
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('already installed'),
    );
    expect(prompts.text).not.toHaveBeenCalled();
  });
});

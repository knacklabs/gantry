import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/channels/provider-registry.js');
  vi.doUnmock('@core/channels/register-builtins.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/config/env/file.js');
  vi.doUnmock('@core/config/settings/runtime-home.js');
  vi.doUnmock('@core/cli/provider-connect.js');
  vi.doUnmock('@core/cli/doctor.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  vi.doUnmock('@clack/prompts');
});

function mockClack() {
  const note = vi.fn();
  const error = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    note,
    isCancel: () => false,
    log: { error, info: vi.fn(), warn: vi.fn() },
    select: vi.fn(),
    text: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  }));
  return { note, error };
}

function mockProviders() {
  vi.doMock('@core/channels/register-builtins.js', () => ({}));
  const provider = {
    id: 'telegram',
    label: 'Telegram',
    jidPrefix: 'tg:',
    folderPrefix: 'telegram',
    formatting: 'telegram-html',
    isGroupJid: () => true,
    isEnabled: () => true,
    create: vi.fn(),
    setup: {
      envKeys: ['TELEGRAM_BOT_TOKEN'],
      describe: () => 'Telegram bot',
      run: vi.fn(),
    },
  };
  vi.doMock('@core/channels/provider-registry.js', () => ({
    registerProvider: vi.fn(),
    getProvider: vi.fn((id: string) =>
      id === 'telegram' ? provider : undefined,
    ),
    listConnectableChannelProviders: vi.fn(() => [provider]),
  }));
  return provider;
}

describe('channel CLI command', () => {
  it('lists configured channel readiness', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(() => ({
        providers: { telegram: { enabled: true } },
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({
      readEnvFile: vi.fn(() => ({ TELEGRAM_BOT_TOKEN: 'token' })),
    }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'list',
    ]);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Telegram: enabled | credentials: configured'),
      'Provider Status',
    );
  });

  it('dispatches connect through the provider connector', async () => {
    mockClack();
    mockProviders();
    const runProviderConnectCommand = vi.fn(() => 0);
    vi.doMock('@core/cli/provider-connect.js', () => ({
      runProviderConnectCommand,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'connect',
      'telegram',
    ]);

    expect(code).toBe(0);
    expect(runProviderConnectCommand).toHaveBeenCalledWith(
      '/tmp/gantry',
      'telegram',
    );
  });

  it('fails connect when provider is missing', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'connect',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('prints Teams in channel connect usage', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'connect',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'gantry provider connect <telegram|slack|discord|teams>',
      ),
    );
  });

  it('fails connect for unknown providers', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'connect',
      'unknown',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith('Unknown provider: unknown');
  });

  it('fails unknown channel subcommands', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'bogus',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('uses scoped channel health for doctor exit status', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/cli/doctor.js', () => ({
      runDoctorWithNetwork: vi.fn(async () => ({
        ok: false,
        blockingFailures: 1,
        warnings: 0,
        checks: [
          {
            id: 'postgres-storage',
            title: 'Database',
            status: 'fail',
            message: 'Database down.',
          },
          {
            id: 'telegram-token',
            title: 'Telegram',
            status: 'pass',
            message: 'Telegram ready.',
          },
        ],
      })),
      formatDoctorReport: vi.fn((report) =>
        report.ok ? 'channel ok' : 'channel failed',
      ),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'doctor',
    ]);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith('channel ok', 'Provider Doctor');
  });

  it('shows and replaces conversation approvers through local services', async () => {
    const { note } = mockClack();
    mockProviders();
    const iso = new Date(0).toISOString();
    const conversation = {
      id: 'conversation-1',
      appId: 'default',
      providerConnectionId: 'providerConnection-1',
      externalRef: { kind: 'conversation', value: 'app-conv-1' },
      kind: 'channel',
      title: 'Engineering',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'app',
      label: 'App',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: iso,
      updatedAt: iso,
    };
    const replaceConversationApprovers = vi.fn(async (input: any) =>
      input.externalUserIds.map((externalUserId: string) => ({
        id: `approver:${externalUserId}`,
        appId: 'default',
        conversationId: 'conversation-1',
        externalUserId,
        createdAt: iso,
        updatedAt: iso,
      })),
    );
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      initializeRuntimeStorage: vi.fn(async () => undefined),
      closeRuntimeStorage: vi.fn(async () => undefined),
      getRuntimeStorage: () => ({
        repositories: {
          providerConnections: {
            getProviderConnection: vi.fn(async () => providerConnection),
            listAgentConversationBindings: vi.fn(async () => []),
            updateProviderConnection: vi.fn(),
          },
          conversations: {
            getConversation: vi.fn(async () => conversation),
            listThreads: vi.fn(async () => []),
            listConversationApprovers: vi.fn(async () => [
              {
                id: 'approver:123',
                appId: 'default',
                conversationId: 'conversation-1',
                externalUserId: '123',
                createdAt: iso,
                updatedAt: iso,
              },
            ]),
            replaceConversationApprovers,
            listParticipantExternalUserIds: vi.fn(async () => ['123', '456']),
          },
        },
      }),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const runtimeStore =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    const showCode = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'control-allowlist',
      'conversation-1',
    ]);
    const setCode = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'control-allowlist',
      'conversation-1',
      '--allow',
      '456,456,123',
    ]);

    expect(showCode).toBe(0);
    expect(setCode).toBe(0);
    expect(runtimeStore.initializeRuntimeStorage).toHaveBeenCalledTimes(2);
    expect(runtimeStore.closeRuntimeStorage).toHaveBeenCalledTimes(2);
    expect(note).toHaveBeenCalledWith('123', 'Conversation Approvers');
    expect(replaceConversationApprovers).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserIds: ['123', '456'] }),
    );
  });

  it.each([
    ['unprefixed external id', '-1003986348737'],
    ['provider-prefixed external id', 'tg:-1003986348737'],
  ])(
    'resolves configured conversation keys for approver inspection with %s',
    async (_label, externalId) => {
      const { note } = mockClack();
      const provider = mockProviders();
      const iso = new Date(0).toISOString();
      const conversation = {
        id: 'conversation:tg:-1003986348737',
        appId: 'default',
        providerConnectionId: 'providerConnection-telegram',
        externalRef: { kind: 'conversation', value: 'tg:-1003986348737' },
        kind: 'channel',
        title: 'Main Agent Telegram Group',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      };
      const getConversation = vi.fn(async (id: string) =>
        id === conversation.id ? conversation : null,
      );
      vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
        initializeRuntimeStorage: vi.fn(async () => undefined),
        closeRuntimeStorage: vi.fn(async () => undefined),
        getRuntimeStorage: () => ({
          repositories: {
            providerConnections: {
              getProviderConnection: vi.fn(async () => ({
                id: 'providerConnection-telegram',
                appId: 'default',
                providerId: 'telegram',
                label: 'Telegram',
                status: 'active',
                config: {},
                runtimeSecretRefs: [],
                createdAt: iso,
                updatedAt: iso,
              })),
              listAgentConversationBindings: vi.fn(async () => []),
              updateProviderConnection: vi.fn(),
            },
            conversations: {
              getConversation,
              listThreads: vi.fn(async () => []),
              listConversationApprovers: vi.fn(async () => [
                {
                  id: 'approver:5759865942',
                  appId: 'default',
                  conversationId: conversation.id,
                  externalUserId: '5759865942',
                  createdAt: iso,
                  updatedAt: iso,
                },
              ]),
              replaceConversationApprovers: vi.fn(),
              listParticipantExternalUserIds: vi.fn(async () => ['5759865942']),
            },
          },
        }),
      }));
      vi.doMock('@core/config/settings/runtime-settings.js', () => ({
        ensureRuntimeSettings: vi.fn(() => ({
          providerConnections: {
            telegram_default: { provider: 'telegram' },
          },
          conversations: {
            main_telegram_group: {
              providerConnection: 'telegram_default',
              externalId,
            },
          },
        })),
      }));
      vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
      vi.doMock('@core/config/settings/runtime-home.js', () => ({
        envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
      }));

      const { runConversationCommand } = await import('@core/cli/provider.js');
      const code = await runConversationCommand('/tmp/gantry', [
        'approvers',
        'main_telegram_group',
      ]);

      expect(code).toBe(0);
      expect(getConversation).toHaveBeenCalledWith(
        'conversation:tg:-1003986348737',
      );
      expect(note).toHaveBeenCalledWith('5759865942', 'Conversation Approvers');
      expect(provider.id).toBe('telegram');
    },
  );
});

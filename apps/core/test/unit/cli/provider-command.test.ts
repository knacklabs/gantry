import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/channels/provider-registry.js');
  vi.doUnmock('@core/channels/register-builtins.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/config/settings/desired-settings-writer.js');
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
  it('chooses an agent-owned provider account instead of a shared default account', async () => {
    const { providerAccountIdForAgent } =
      await import('@core/cli/provider-utils.js');
    const settings = {
      providerAccounts: {
        slack_default: {
          agentId: 'main_agent',
          provider: 'slack',
          label: 'Main Slack',
          runtimeSecretRefs: {},
        },
        slack_recruiting_agent: {
          agentId: 'recruiting_agent',
          provider: 'slack',
          label: 'Recruiting Slack',
          runtimeSecretRefs: {},
        },
      },
    } as any;

    expect(
      providerAccountIdForAgent(settings, {
        providerId: 'slack',
        agentId: 'recruiting_agent',
        defaultAccountId: 'slack_default',
      }),
    ).toBe('slack_recruiting_agent');
  });

  it('creates a provider account id for the agent when the default belongs to another agent', async () => {
    const { providerAccountIdForAgent } =
      await import('@core/cli/provider-utils.js');
    const settings = {
      providerAccounts: {
        slack_default: {
          agentId: 'main_agent',
          provider: 'slack',
          label: 'Main Slack',
          runtimeSecretRefs: {},
        },
      },
    } as any;

    expect(
      providerAccountIdForAgent(settings, {
        providerId: 'slack',
        agentId: 'sales_agent',
        defaultAccountId: 'slack_default',
      }),
    ).toBe('slack_sales_agent');
  });

  it('reports missing provider account even when raw env credentials exist', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(() => ({
        providers: { telegram: { enabled: true } },
        providerAccounts: {},
      })),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        providers: { telegram: { enabled: true } },
        providerAccounts: {},
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
      expect.stringContaining(
        'Telegram: enabled | credentials: missing provider account',
      ),
      'Provider Status',
    );
  });

  it('lists configured channel readiness from active provider account refs', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        providers: { telegram: { enabled: true } },
        providerAccounts: {
          telegram_main: {
            provider: 'telegram',
            status: 'active',
            runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
          },
        },
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({
      readEnvFile: vi.fn(() => ({})),
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
      expect.stringContaining(
        'Telegram: enabled | credentials: secret refs configured',
      ),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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

  it('lists Provider Accounts without internal binding copy', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      initializeRuntimeStorage: vi.fn(async () => undefined),
      closeRuntimeStorage: vi.fn(async () => undefined),
      getRuntimeStorage: () => ({
        repositories: {
          providerAccounts: {
            listProviderAccounts: vi.fn(async () => [
              {
                id: 'provider-account:telegram:main',
                appId: 'default',
                agentId: 'agent:main',
                providerId: 'telegram',
                label: 'Main Telegram',
                status: 'active',
                config: {},
                runtimeSecretRefs: { bot_token: 'gantry-secret:TG_TOKEN' },
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
              },
            ]),
          },
        },
      }),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'account',
      'list',
    ]);

    expect(code).toBe(0);
    const body = note.mock.calls[0]?.[0] as string;
    expect(body).toContain('Provider Account: Main Telegram');
    expect(body).toContain('Agent: agent:main');
    expect(body).toContain('Status: Installed');
    expect(body).not.toMatch(/binding|@agent/i);
  });

  it('rejects raw-looking Provider Account secret values at the CLI boundary', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'account',
      'connect',
      'telegram',
      '--agent',
      'agent:main',
      '--secret-ref',
      'bot_token=raw-token',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('runtime secret refs'),
    );
  });

  it('connects Provider Accounts through desired settings', async () => {
    const { note } = mockClack();
    mockProviders();
    const settings: any = {
      providers: { telegram: { enabled: false } },
      providerAccounts: {},
      conversations: {},
      agents: {
        main_agent: {
          name: 'Main',
          folder: 'main_agent',
          bindings: {},
          sources: { skills: [], mcpServers: [], tools: [] },
          capabilities: [],
        },
      },
    };
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
      noteRestartRequired: vi.fn(),
      writeDesiredRuntimeSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      initializeRuntimeStorage: vi.fn(),
      closeRuntimeStorage: vi.fn(),
      getRuntimeStorage: vi.fn(),
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'account',
      'connect',
      'telegram',
      '--agent',
      'agent:main_agent',
      '--id',
      'telegram_main',
      '--secret-ref',
      'bot_token=env:TELEGRAM_BOT_TOKEN',
    ]);

    expect(code).toBe(0);
    expect(settings.providers.telegram.enabled).toBe(true);
    expect(settings.providerAccounts.telegram_main).toMatchObject({
      agentId: 'main_agent',
      provider: 'telegram',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    });
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHome: '/tmp/gantry',
        settings,
        createdBy: 'cli:provider-account-connect',
      }),
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Provider Account: Telegram Provider Account'),
      'Provider Account',
    );
  });

  it('rotates Provider Account secret refs through desired settings', async () => {
    const { note } = mockClack();
    mockProviders();
    const settings: any = {
      providers: { telegram: { enabled: true } },
      providerAccounts: {
        telegram_main: {
          agentId: 'main_agent',
          provider: 'telegram',
          label: 'Telegram Main',
          status: 'active',
          runtimeSecretRefs: { bot_token: 'env:OLD_TOKEN' },
          config: {},
        },
      },
      conversations: {},
      agents: {
        main_agent: {
          name: 'Main',
          folder: 'main_agent',
          bindings: {},
          sources: { skills: [], mcpServers: [], tools: [] },
          capabilities: [],
        },
      },
    };
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
      noteRestartRequired: vi.fn(),
      writeDesiredRuntimeSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      initializeRuntimeStorage: vi.fn(),
      closeRuntimeStorage: vi.fn(),
      getRuntimeStorage: vi.fn(),
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/gantry', [
      'account',
      'rotate-secret',
      'telegram_main',
      '--key',
      'bot_token',
      '--ref',
      'env:NEW_TOKEN',
    ]);

    expect(code).toBe(0);
    expect(settings.providerAccounts.telegram_main.runtimeSecretRefs).toEqual({
      bot_token: 'env:NEW_TOKEN',
    });
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHome: '/tmp/gantry',
        settings,
        createdBy: 'cli:provider-account-rotate-secret',
      }),
    );
    expect(note).toHaveBeenCalledWith(
      'Provider Account secret ref updated.',
      'Provider Account',
    );
  });

  it('installs conversations through desired settings', async () => {
    const { note } = mockClack();
    mockProviders();
    const iso = new Date(0).toISOString();
    const settings: any = {
      providers: { telegram: { enabled: true } },
      providerAccounts: {
        telegram_main: {
          agentId: 'main_agent',
          provider: 'telegram',
          label: 'Telegram Main',
          runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
        },
      },
      conversations: {},
      agents: {
        main_agent: {
          name: 'Main',
          folder: 'main_agent',
          bindings: {},
          sources: { skills: [], mcpServers: [], tools: [] },
          capabilities: [],
        },
      },
    };
    const saveConversationInstall = vi.fn();
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
      noteRestartRequired: vi.fn(),
      writeDesiredRuntimeSettings,
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      initializeRuntimeStorage: vi.fn(async () => undefined),
      closeRuntimeStorage: vi.fn(async () => undefined),
      getRuntimeStorage: () => ({
        repositories: {
          providerAccounts: {
            getProviderAccount: vi.fn(async () => ({
              id: 'telegram_main',
              appId: 'default',
              agentId: 'agent:main_agent',
              providerId: 'telegram',
              label: 'Telegram Main',
              status: 'active',
              config: {},
              runtimeSecretRefs: {},
              createdAt: iso,
              updatedAt: iso,
            })),
            saveConversationInstall,
          },
          conversations: {
            getConversation: vi.fn(async () => ({
              id: 'conversation:tg:-100',
              appId: 'default',
              providerAccountId: 'telegram_main',
              externalRef: { kind: 'conversation', value: '-100' },
              kind: 'channel',
              title: 'Ops',
              status: 'active',
              createdAt: iso,
              updatedAt: iso,
            })),
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

    const { runConversationCommand } = await import('@core/cli/provider.js');
    const code = await runConversationCommand('/tmp/gantry', [
      'install',
      '--agent',
      'main_agent',
      '--provider-account',
      'telegram_main',
      '--conversation',
      'conversation:tg:-100',
    ]);

    expect(code).toBe(0);
    expect(saveConversationInstall).not.toHaveBeenCalled();
    const conversationKey = Object.keys(settings.conversations)[0];
    expect(conversationKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
    expect(conversationKey).not.toContain(':');
    expect(settings.conversations[conversationKey]).toMatchObject({
      providerAccount: 'telegram_main',
      externalId: '-100',
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'telegram_main',
          status: 'active',
          memoryScope: 'conversation',
          requiresTrigger: true,
        },
      },
    });
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHome: '/tmp/gantry',
        settings,
        createdBy: 'cli:conversation-install',
      }),
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Status: Installed'),
      'Conversation Install',
    );
  });

  it('shows and replaces conversation approvers through local services', async () => {
    const { note } = mockClack();
    mockProviders();
    const iso = new Date(0).toISOString();
    const conversation = {
      id: 'conversation-1',
      appId: 'default',
      providerAccountId: 'provider-account-1',
      externalRef: { kind: 'conversation', value: 'app-conv-1' },
      kind: 'channel',
      title: 'Engineering',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const providerAccount = {
      id: 'provider-account-1',
      appId: 'default',
      agentId: 'agent:main',
      providerId: 'app',
      label: 'App',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
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
          providerAccounts: {
            getProviderAccount: vi.fn(async () => providerAccount),
            listConversationInstalls: vi.fn(async () => []),
            updateProviderAccount: vi.fn(),
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
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        conversations: {},
        providerAccounts: {},
      })),
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
        id: 'conversation:telegram_default:tg:-1003986348737',
        appId: 'default',
        providerAccountId: 'provider-account-telegram',
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
            providerAccounts: {
              getProviderAccount: vi.fn(async () => ({
                id: 'provider-account-telegram',
                appId: 'default',
                agentId: 'agent:main',
                providerId: 'telegram',
                label: 'Telegram',
                status: 'active',
                config: {},
                runtimeSecretRefs: {},
                createdAt: iso,
                updatedAt: iso,
              })),
              listConversationInstalls: vi.fn(async () => []),
              updateProviderAccount: vi.fn(),
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
          providerAccounts: {
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
      vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
        loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
          providerAccounts: {
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
        'conversation:telegram_default:tg:-1003986348737',
      );
      expect(note).toHaveBeenCalledWith('5759865942', 'Conversation Approvers');
      expect(provider.id).toBe('telegram');
    },
  );

  it('resolves raw provider JIDs through the matching provider account', async () => {
    const { note } = mockClack();
    mockProviders();
    const iso = new Date(0).toISOString();
    const conversation = {
      id: 'conversation:telegram_default:tg:-1003986348737',
      appId: 'default',
      providerAccountId: 'telegram_default',
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
          providerAccounts: {
            getProviderAccount: vi.fn(async () => ({
              id: 'telegram_default',
              appId: 'default',
              agentId: 'agent:main',
              providerId: 'telegram',
              label: 'Telegram',
              status: 'active',
              config: {},
              runtimeSecretRefs: {},
              createdAt: iso,
              updatedAt: iso,
            })),
            listConversationInstalls: vi.fn(async () => []),
          },
          conversations: {
            getConversation,
            listThreads: vi.fn(async () => []),
            listConversationApprovers: vi.fn(async () => []),
            listParticipantExternalUserIds: vi.fn(async () => []),
          },
        },
      }),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        providerAccounts: {
          telegram_default: { provider: 'telegram' },
        },
        conversations: {},
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runConversationCommand } = await import('@core/cli/provider.js');
    const code = await runConversationCommand('/tmp/gantry', [
      'info',
      'tg:-1003986348737',
    ]);

    expect(code).toBe(0);
    expect(getConversation).toHaveBeenCalledWith(
      'conversation:telegram_default:tg:-1003986348737',
    );
    expect(getConversation).not.toHaveBeenCalledWith(
      'conversation:tg:-1003986348737',
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Main Agent Telegram Group'),
      'Conversation Info',
    );
  });

  it('rejects ambiguous raw provider JIDs instead of constructing legacy ids', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      initializeRuntimeStorage: vi.fn(),
      closeRuntimeStorage: vi.fn(),
      getRuntimeStorage: vi.fn(),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
      loadDesiredRuntimeSettingsForWrite: vi.fn(async () => ({
        providerAccounts: {
          telegram_default: { provider: 'telegram' },
          telegram_sales: { provider: 'telegram' },
        },
        conversations: {},
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runConversationCommand } = await import('@core/cli/provider.js');
    const code = await runConversationCommand('/tmp/gantry', [
      'info',
      'tg:-1003986348737',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('--provider-account <id>'),
    );
  });
});

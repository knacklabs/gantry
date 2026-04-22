import { afterEach, describe, expect, it, vi } from 'vitest';

const CANCEL = Symbol('cancel');

interface SetupFlowTestOptions {
  selectQueue: unknown[];
  textQueue?: unknown[];
  passwordQueue?: unknown[];
  env?: Record<string, string>;
  onecliReject?: boolean;
  doctorReports?: Array<{
    ok: boolean;
    blockingFailures: number;
    warnings: number;
    checks: Array<{
      id: string;
      title: string;
      status: 'pass' | 'warn' | 'fail';
      message: string;
      nextAction?: string;
    }>;
  }>;
  doctorReport?: {
    ok: boolean;
    blockingFailures: number;
    warnings: number;
    checks: Array<{
      id: string;
      title: string;
      status: 'pass' | 'warn' | 'fail';
      message: string;
      nextAction?: string;
    }>;
  };
}

async function loadSetupFlowModule(options: SetupFlowTestOptions) {
  vi.resetModules();

  const selectQueue = [...options.selectQueue];
  const textQueue = [...(options.textQueue || [])];
  const passwordQueue = [...(options.passwordQueue || [])];
  const doctorReports = [...(options.doctorReports || [])];
  const promptCalls: Array<{
    kind: 'select' | 'text' | 'password';
    message: string;
    options?: unknown[];
  }> = [];

  const select = vi.fn(
    async (input: { message: string; options?: Array<{ value: unknown }> }) => {
      promptCalls.push({
        kind: 'select',
        message: input.message,
        options: input.options?.map((option) => option.value),
      });
      return selectQueue.shift() ?? 'resume';
    },
  );
  const text = vi.fn(async (input: { message: string }) => {
    promptCalls.push({ kind: 'text', message: input.message });
    return textQueue.shift() ?? '';
  });
  const password = vi.fn(async (input: { message: string }) => {
    promptCalls.push({ kind: 'password', message: input.message });
    return passwordQueue.shift() ?? CANCEL;
  });
  const note = vi.fn();
  const intro = vi.fn();
  const outro = vi.fn();
  const spinnerStart = vi.fn();
  const spinnerStop = vi.fn();
  const persistOnboardingConfig = vi.fn();
  const writeOnboardingState = vi.fn();
  const clearOnboardingState = vi.fn();
  const getContainerConfig = vi.fn();
  const runDoctorWithNetwork = vi.fn(
    async () =>
      doctorReports.shift() ||
      options.doctorReport || {
        ok: true,
        blockingFailures: 0,
        warnings: 0,
        checks: [],
      },
  );

  if (options.onecliReject) {
    getContainerConfig.mockRejectedValue(new Error('ECONNREFUSED'));
  } else {
    getContainerConfig.mockResolvedValue({ env: {} });
  }

  vi.doMock('@clack/prompts', () => ({
    select,
    text,
    password,
    note,
    intro,
    outro,
    isCancel: (value: unknown) => value === CANCEL,
    spinner: () => ({
      start: spinnerStart,
      stop: spinnerStop,
    }),
    log: {
      error: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
    },
  }));

  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: function OneCLI() {
      return { getContainerConfig };
    },
  }));

  vi.doMock('@core/cli/doctor.js', () => ({
    formatDoctorReport: () => 'doctor report',
    hasProcessableGroupForConfiguredChannel: () => true,
    hasRuntimeConfig: () => true,
    runDoctorWithNetwork,
  }));
  vi.doMock('@core/cli/env-file.js', () => ({
    readEnvFile: vi.fn(() => options.env || {}),
  }));
  vi.doMock('@core/cli/onboarding-config.js', () => ({
    persistOnboardingConfig,
  }));
  vi.doMock('@core/cli/onboarding-state.js', () => ({
    createInitialState: (runtimeHome: string) => ({
      version: 1,
      status: 'in_progress',
      currentStep: 'welcome',
      updatedAt: new Date().toISOString(),
      data: { runtimeHome },
    }),
    readOnboardingState: () => null,
    writeOnboardingState,
    clearOnboardingState,
  }));
  vi.doMock('@core/cli/runtime-home.js', () => ({
    envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    ensureRuntimeWritable: vi.fn(),
    resolveRuntimeHome: (runtimeHome: string) => runtimeHome,
  }));
  vi.doMock('@core/cli/runtime-settings.js', () => ({
    loadRuntimeSettings: vi.fn(() => ({
      storage: {
        provider: 'sqlite',
        sqlite: {
          path: 'store/myclaw.db',
        },
        postgres: {
          urlEnv: 'MYCLAW_DATABASE_URL',
        },
      },
      channels: {
        telegram: {
          enabled: false,
          senderAllowlist: {
            default: { allow: '*', mode: 'trigger' },
            agents: {},
            logDenied: true,
          },
        },
        slack: {
          enabled: false,
          senderAllowlist: {
            default: { allow: '*', mode: 'trigger' },
            agents: {},
            logDenied: true,
          },
        },
      },
      memory: {
        enabled: true,
        root: 'memory',
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: 'text-embedding-3-large',
        },
        dreaming: {
          enabled: false,
        },
        llm: {
          models: {
            extractor: 'claude-haiku-4-5-20251001',
            dreaming: 'claude-sonnet-4-6',
            consolidation: 'claude-sonnet-4-6',
          },
        },
      },
    })),
    readRuntimeStorageSettingsSnapshot: vi.fn((runtimeHome: string) => ({
      provider: 'sqlite',
      sqlitePath: `${runtimeHome}/store/myclaw.db`,
      postgresUrl: null,
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
    })),
    readRuntimeMemorySettingsSnapshot: vi.fn(() => ({
      enabled: true,
      root: 'memory',
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: 'text-embedding-3-large',
      },
      dreaming: { enabled: true },
    })),
  }));
  vi.doMock('@core/cli/telegram.js', () => ({
    normalizeTelegramChatJid: vi.fn((value: string) =>
      value.trim().startsWith('tg:')
        ? value.trim()
        : value.trim()
          ? `tg:${value}`
          : '',
    ),
    registerTelegramMainGroup: vi.fn(async () => ({
      groupName: 'Telegram Main',
      folder: 'telegram-main',
    })),
    validateTelegramBotToken: vi.fn(async () => ({
      ok: true,
      message: 'ok',
      username: 'bot',
      botId: 123,
    })),
    verifyTelegramChatAccess: vi.fn(async () => ({
      ok: true,
      message: 'ok',
      chatTitle: 'Chat',
    })),
  }));
  vi.doMock('@core/cli/telegram-chat-discovery.js', () => ({
    listTelegramRecentChats: vi.fn(async () => ({
      ok: true,
      message: 'ok',
      chats: [
        {
          chatJid: 'tg:-1001234567890',
          chatTitle: 'Telegram Main',
          chatType: 'group',
          sourceUpdateId: 1,
        },
      ],
    })),
  }));
  vi.doMock('@core/cli/slack-chat-discovery.js', () => ({
    listSlackRecentChats: vi.fn(async () => ({
      ok: true,
      message: 'ok',
      chats: [
        {
          chatJid: 'sl:C0123456789',
          chatTitle: 'general',
          chatType: 'public_channel',
          sourceTs: 1,
        },
      ],
    })),
  }));
  vi.doMock('@core/cli/slack.js', () => ({
    normalizeSlackChatJid: vi.fn((value: string) =>
      value.trim().startsWith('sl:')
        ? value.trim()
        : value.trim()
          ? `sl:${value.trim()}`
          : '',
    ),
    registerSlackMainGroup: vi.fn(async () => ({
      groupName: 'Slack Main',
      folder: 'slack-main',
    })),
    validateSlackAppToken: vi.fn(async () => ({
      ok: true,
      message: 'ok',
    })),
    validateSlackBotToken: vi.fn(async () => ({
      ok: true,
      message: 'ok',
    })),
    verifySlackChatAccess: vi.fn(async () => ({
      ok: true,
      message: 'ok',
      chatTitle: 'general',
    })),
  }));
  vi.doMock('@core/cli/service-manager.js', () => ({
    getServiceStatus: vi.fn(() => ({ kind: 'none', status: 'not installed' })),
    installService: vi.fn(() => ({ ok: true, message: 'installed' })),
    startService: vi.fn(() => ({ ok: true, message: 'started' })),
  }));

  const mod = await import('@core/cli/setup-flow.js');
  return {
    runSetupFlow: mod.runSetupFlow,
    persistOnboardingConfig,
    writeOnboardingState,
    getContainerConfig,
    select,
    text,
    password,
    promptCalls,
    runDoctorWithNetwork,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runSetupFlow credential step', () => {
  it('enforces strict OneCLI validation for onecli-only mode', async () => {
    const mod = await loadSetupFlowModule({
      selectQueue: ['onecli-only', 'resume'],
      textQueue: ['http://localhost:10254'],
      onecliReject: true,
    });

    const result = await mod.runSetupFlow({
      importMetaUrl: import.meta.url,
      runtimeHome: '/tmp/myclaw-test',
      initialStep: 'credentials',
    });

    expect(result.status).toBe('resumed');
    expect(mod.getContainerConfig).toHaveBeenCalledTimes(1);
    expect(mod.persistOnboardingConfig).not.toHaveBeenCalled();
  });

  it('allows hybrid mode to continue when OneCLI validation fails', async () => {
    const mod = await loadSetupFlowModule({
      selectQueue: ['hybrid', 'continue', 'api_key'],
      textQueue: ['http://localhost:10254'],
      passwordQueue: ['sk-ant-test'],
      onecliReject: true,
    });

    const result = await mod.runSetupFlow({
      importMetaUrl: import.meta.url,
      runtimeHome: '/tmp/myclaw-test',
      initialStep: 'credentials',
    });

    expect(result.status).toBe('resumed');
    expect(mod.getContainerConfig).toHaveBeenCalledTimes(1);
    expect(mod.password).toHaveBeenCalled();
  });

  it('skips OneCLI validation for env-only mode', async () => {
    const mod = await loadSetupFlowModule({
      selectQueue: ['env-only', 'api_key'],
      passwordQueue: ['sk-ant-test'],
    });

    const result = await mod.runSetupFlow({
      importMetaUrl: import.meta.url,
      runtimeHome: '/tmp/myclaw-test',
      initialStep: 'credentials',
    });

    expect(result.status).toBe('resumed');
    expect(mod.getContainerConfig).not.toHaveBeenCalled();
    expect(mod.text).not.toHaveBeenCalled();
  });

  it('keeps storage setup on sqlite without requesting a database URL', async () => {
    const mod = await loadSetupFlowModule({
      selectQueue: ['sqlite'],
    });

    const result = await mod.runSetupFlow({
      importMetaUrl: import.meta.url,
      runtimeHome: '/tmp/myclaw-test',
      initialStep: 'storage',
    });

    expect(result.status).toBe('resumed');
    expect(mod.password).not.toHaveBeenCalled();
  });

  it('asks fresh-user setup questions in the expected order', async () => {
    const mod = await loadSetupFlowModule({
      selectQueue: [
        'next',
        'next',
        'sqlite',
        'next',
        'telegram',
        'tg:-1001234567890',
        'next',
        'env-only',
        'oauth',
        'claude-sonnet-4-6',
        'on',
        'off',
        'on',
        'next',
        'next',
        'skip',
        'next',
        'next',
      ],
      textQueue: ['/tmp/myclaw-test', 'Telegram Main'],
      passwordQueue: ['telegram-token', 'claude-oauth-token'],
      doctorReports: [
        {
          ok: true,
          blockingFailures: 0,
          warnings: 0,
          checks: [],
        },
      ],
    });

    const result = await mod.runSetupFlow({
      importMetaUrl: import.meta.url,
      runtimeHome: '/tmp/myclaw-test',
    });

    expect(result.status).toBe('completed');
    expect(mod.runDoctorWithNetwork).toHaveBeenCalledTimes(1);
    expect(mod.promptCalls.map((call) => call.message)).toEqual([
      'Start guided setup now?',
      'Where should MyClaw store runtime data?',
      'Use this runtime home?',
      'Choose storage backend',
      'Continue to provider selection?',
      'Choose your first channel provider',
      'Paste your Telegram bot token from BotFather (/back, /resume, /cancel)',
      'Choose the Telegram chat for MyClaw',
      'Choose a name for this Telegram chat in MyClaw (/back, /resume, /cancel)',
      'Use these Telegram settings?',
      'Credential source mode',
      'How should MyClaw authenticate with Claude?',
      'Paste CLAUDE_CODE_OAUTH_TOKEN (/back, /resume, /cancel)',
      'Choose main model',
      'Memory setting',
      'Embeddings setting',
      'Dreaming setting',
      'Continue to group creation?',
      'Continue to optional service setup?',
      'Background service (optional)',
      'Verification passed. Continue to ready screen?',
      'Setup complete. What should MyClaw do now?',
    ]);
    expect(
      mod.promptCalls
        .find(
          (call) =>
            call.message === 'Setup complete. What should MyClaw do now?',
        )
        ?.options?.slice(0, 2),
    ).toEqual(['next', 'start_now']);
  });
});

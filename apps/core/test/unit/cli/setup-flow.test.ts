import { afterEach, describe, expect, it, vi } from 'vitest';

const CANCEL = Symbol('cancel');

interface SetupFlowTestOptions {
  selectQueue: unknown[];
  textQueue?: unknown[];
  passwordQueue?: unknown[];
  env?: Record<string, string>;
  onecliReject?: boolean;
}

async function loadSetupFlowModule(options: SetupFlowTestOptions) {
  vi.resetModules();

  const selectQueue = [...options.selectQueue];
  const textQueue = [...(options.textQueue || [])];
  const passwordQueue = [...(options.passwordQueue || [])];

  const select = vi.fn(async () => selectQueue.shift() ?? 'resume');
  const text = vi.fn(async () => textQueue.shift() ?? '');
  const password = vi.fn(async () => passwordQueue.shift() ?? CANCEL);
  const note = vi.fn();
  const intro = vi.fn();
  const outro = vi.fn();
  const spinnerStart = vi.fn();
  const spinnerStop = vi.fn();
  const persistOnboardingConfig = vi.fn();
  const writeOnboardingState = vi.fn();
  const clearOnboardingState = vi.fn();
  const getContainerConfig = vi.fn();

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
    hasRegisteredTelegramGroup: () => true,
    hasRuntimeConfig: () => true,
    runDoctorWithNetwork: vi.fn(async () => ({ ok: true, checks: [] })),
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
    savePreferredRuntimeHome: vi.fn(),
  }));
  vi.doMock('@core/cli/runtime-settings.js', () => ({
    loadRuntimeSettings: vi.fn(() => ({
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
        provider: 'sqlite',
        sqlitePath: 'store/memory.db',
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
            sessionSummary: 'claude-haiku-4-5-20251001',
          },
        },
      },
    })),
  }));
  vi.doMock('@core/cli/telegram.js', () => ({
    normalizeTelegramChatJid: vi.fn((value: string) =>
      value.trim() ? `tg:${value}` : '',
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
      selectQueue: ['hybrid', 'continue'],
      textQueue: ['http://localhost:10254'],
      passwordQueue: [CANCEL],
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
      selectQueue: ['env-only'],
      passwordQueue: [CANCEL],
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
});

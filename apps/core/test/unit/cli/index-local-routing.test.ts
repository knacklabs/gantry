import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cli-db-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/infrastructure/service/manager.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  vi.doUnmock('@core/adapters/storage/postgres/storage-service.js');
  vi.doUnmock('@core/cli/provider.js');
  vi.doUnmock('@core/cli/provider-connect.js');
  vi.doUnmock('@core/cli/credentials.js');
  vi.doUnmock('@core/cli/onboarding-state.js');
  vi.doUnmock('@core/cli/setup-flow.js');
  vi.doUnmock('@core/cli/setup-flow-core-steps.js');
  vi.doUnmock('@core/cli/setup-credentials.js');
  vi.doUnmock('@core/cli/setup-flow-provider-steps.js');
  vi.doUnmock('@core/cli/setup-flow-final-steps.js');
  vi.doUnmock('@core/cli/setup-ready.js');
  vi.doUnmock('@core/cli/local.js');
  vi.doUnmock('@core/app/index.js');
  vi.doUnmock('@core/postgres-migrate.js');
  vi.doUnmock('@core/config/preflight.js');
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('CLI local routing', () => {
  it('uses credentials access in top-level help', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      output.push(String(message));
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    const { main } = await import('@core/cli/index.js');

    const code = await main(['--help']);

    expect(code).toBe(0);
    expect(output.join('\n')).toContain(
      'gantry credentials model|access|browser',
    );
    expect(output.join('\n')).not.toContain('credentials capability');
  });

  it.each([
    ['welcome', 'welcome'],
    ['channel', 'channel'],
    ['model', 'model'],
    ['memory', 'memory'],
    ['credentials', 'credentials'],
    ['storage', 'storage'],
    ['verify', 'verify'],
  ] as const)(
    'starts completed setup menu choice %s at %s',
    async (choice, expectedStep) => {
      const runtimeHome = makeRuntimeHome();
      const onboarding = await import('@core/cli/onboarding-state.js');
      const state = onboarding.createInitialState(runtimeHome);
      state.status = 'completed';
      state.currentStep = 'ready';
      onboarding.writeOnboardingState(runtimeHome, state);
      const select = vi.fn(async () => choice);
      const runSetupFlow = vi.fn(async () => ({
        status: 'completed',
        runtimeHome,
        startAfterSetup: false,
      }));
      vi.doMock('@clack/prompts', () => ({
        isCancel: () => false,
        outro: vi.fn(),
        select,
        log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      }));
      vi.doMock('@core/cli/setup-flow.js', () => ({
        runSetupFlow,
      }));

      const { main } = await import('@core/cli/index.js');
      const code = await main(['--runtime-home', runtimeHome, 'setup']);

      expect(code).toBe(0);
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'What do you want to change?' }),
      );
      expect(runSetupFlow).toHaveBeenCalledWith(
        expect.objectContaining({ initialStep: expectedStep }),
      );
      expect(onboarding.readOnboardingState(runtimeHome)).toMatchObject({
        status: 'in_progress',
        currentStep: expectedStep,
      });
    },
  );

  it('skips channel reconnect steps for memory maintenance when a binding exists', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'providers: {}\n',
    );

    const runMemoryStep = vi.fn(async () => ({ type: 'next' }));
    const runCredentialsStep = vi.fn(async () => ({ type: 'next' }));
    const runTelegramStep = vi.fn(async () => ({ type: 'next' }));
    const runSlackStep = vi.fn(async () => ({ type: 'next' }));
    const runConfigStep = vi.fn(async () => ({ type: 'next' }));
    const runGroupStep = vi.fn(async () => ({ type: 'next' }));
    const runVerifyStep = vi.fn(async () => ({ type: 'next' }));
    const runReadyStep = vi.fn(async () => ({ type: 'next' }));
    const select = vi.fn(async () => 'memory');

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      isCancel: () => false,
      select,
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        success: vi.fn(),
        step: vi.fn(),
        message: vi.fn(),
      },
    }));
    vi.doMock(
      '@core/config/settings/runtime-settings.js',
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('@core/config/settings/runtime-settings.js')
          >();
        const settings = actual.createDefaultRuntimeSettings();
        settings.providers.slack.enabled = true;
        settings.providerAccounts.slack_default = {
          agentId: 'main_agent',
          provider: 'slack',
          label: 'Slack',
          runtimeSecretRefs: {
            bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
            app_token: 'gantry-secret:SLACK_APP_TOKEN',
          },
        };
        settings.agents.main_agent = {
          name: 'Main',
          folder: 'main_agent',
          model: 'opus',
          bindings: {
            main: {
              jid: 'sl:C123',
              provider: 'slack',
              name: 'Ops',
              trigger: '@Main',
              addedAt: '2026-01-01T00:00:00.000Z',
              requiresTrigger: false,
            },
          },
          sources: { skills: [], mcpServers: [], tools: [] },
          capabilities: [],
          accessPreset: 'full',
        };
        return {
          ...actual,
          configureDesiredSettingsStorageProvider: vi.fn(),
          ensureRuntimeSettings: vi.fn(() => settings),
          loadRuntimeSettingsFromPath: vi.fn(() => settings),
        };
      },
    );
    vi.doMock('@core/cli/setup-flow-core-steps.js', () => ({
      runAddAgentSetupSlice: vi.fn(),
      runWelcomeStep: vi.fn(),
      runRuntimeHomeStep: vi.fn(),
      runStorageStep: vi.fn(),
      runChannelStep: vi.fn(),
      runModelStep: vi.fn(),
      runMemoryStep,
    }));
    vi.doMock('@core/cli/setup-credentials.js', () => ({
      runCredentialsStep,
    }));
    vi.doMock('@core/cli/setup-flow-provider-steps.js', () => ({
      runTelegramStep,
      runSlackStep,
    }));
    vi.doMock('@core/cli/setup-flow-final-steps.js', () => ({
      runConfigStep,
      runGroupStep,
      runVerifyStep,
    }));
    vi.doMock('@core/cli/setup-ready.js', () => ({
      runReadyStep,
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(0);
    expect(runMemoryStep).toHaveBeenCalledTimes(1);
    expect(runCredentialsStep).toHaveBeenCalledTimes(1);
    expect(runConfigStep).toHaveBeenCalledTimes(1);
    expect(runVerifyStep).toHaveBeenCalledTimes(1);
    expect(runReadyStep).toHaveBeenCalledTimes(1);
    expect(runTelegramStep).not.toHaveBeenCalled();
    expect(runSlackStep).not.toHaveBeenCalled();
    expect(runGroupStep).not.toHaveBeenCalled();
  });

  it('runs the completed setup add-agent mini-flow', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === 'What do you want to change?') return 'add_agent';
      if (message === 'Choose this agent chat model') return 'gpt';
      if (message === 'Choose a channel to connect this agent') return 'slack';
      return 'cancel';
    });
    const text = vi.fn(async () => 'Research Bot');
    const runSetupFlow = vi.fn(async () => ({
      status: 'completed',
      runtimeHome,
      startAfterSetup: false,
    }));
    const listReadyModelCredentialProviders = vi.fn(async () => new Set());
    const promptModelCredentialPayload = vi.fn(async () => ({
      authMode: 'api_key',
      payload: { apiKey: 'sk-test' },
    }));
    const verifyModelCredentialInputWithPrompt = vi.fn(async () => ({
      type: 'verified',
    }));
    const storeModelCredentialInput = vi.fn(async () => undefined);
    const runProviderConnectCommand = vi.fn(async () => 0);
    const settings = { agents: {} as Record<string, any> };
    const writeDesiredRuntimeSettings = vi.fn(async (input) => {
      Object.assign(settings, structuredClone(input.settings));
      return { reconciled: true };
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      outro: vi.fn(),
      select,
      text,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    vi.doMock(
      '@core/config/settings/runtime-settings.js',
      async (importOriginal) => ({
        ...(await importOriginal<
          typeof import('@core/config/settings/runtime-settings.js')
        >()),
        configureDesiredSettingsStorageProvider: vi.fn(),
        ensureRuntimeSettings: vi.fn(),
        loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
        writeDesiredRuntimeSettings,
        ensureConfiguredAgent: vi.fn((target, input) => {
          target.agents[input.agentId] ??= {
            name: input.agentName,
            folder: input.agentFolder,
            persona: 'developer',
            bindings: {},
            sources: { skills: [], mcpServers: [], tools: [] },
            capabilities: [],
            accessPreset: 'full',
          };
        }),
      }),
    );
    vi.doMock('@core/cli/setup-flow.js', () => ({ runSetupFlow }));
    vi.doMock('@core/cli/credentials.js', () => ({
      listReadyModelCredentialProviders,
      promptModelCredentialPayload,
      verifyModelCredentialInputWithPrompt,
      storeModelCredentialInput,
    }));
    vi.doMock('@core/cli/provider-connect.js', () => ({
      runProviderConnectCommand,
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getAllConversationRoutes: vi.fn(async () => ({
          'slack:C123': { name: 'Research Bot', folder: 'research_bot' },
        })),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(0);
    expect(runSetupFlow).not.toHaveBeenCalled();
    expect(settings.agents.research_bot).toMatchObject({
      name: 'Research Bot',
      model: 'gpt',
    });
    expect(promptModelCredentialPayload).toHaveBeenCalledWith('openai');
    expect(verifyModelCredentialInputWithPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', authMode: 'api_key' }),
    );
    expect(storeModelCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeHome, providerId: 'openai' }),
    );
    expect(runProviderConnectCommand).toHaveBeenCalledWith(
      runtimeHome,
      'slack',
      'research_bot',
      'Research Bot',
    );
  });

  it('does not persist an add-agent when the conversation kept its existing owner', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === 'What do you want to change?') return 'add_agent';
      if (message === 'Choose this agent chat model') return 'gpt';
      if (message === 'Choose a channel to connect this agent') return 'slack';
      return 'cancel';
    });
    const text = vi.fn(async () => 'Research Bot');
    const logError = vi.fn();
    const settings = { agents: {} as Record<string, unknown> };
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      outro: vi.fn(),
      select,
      text,
      log: { error: logError, info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    vi.doMock(
      '@core/config/settings/runtime-settings.js',
      async (importOriginal) => ({
        ...(await importOriginal<
          typeof import('@core/config/settings/runtime-settings.js')
        >()),
        configureDesiredSettingsStorageProvider: vi.fn(),
        ensureRuntimeSettings: vi.fn(),
        loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
        writeDesiredRuntimeSettings,
      }),
    );
    vi.doMock('@core/cli/setup-flow.js', () => ({
      runSetupFlow: vi.fn(),
    }));
    vi.doMock('@core/cli/credentials.js', () => ({
      listReadyModelCredentialProviders: vi.fn(async () => new Set(['openai'])),
      promptModelCredentialPayload: vi.fn(),
      verifyModelCredentialInputWithPrompt: vi.fn(),
      storeModelCredentialInput: vi.fn(),
    }));
    vi.doMock('@core/cli/provider-connect.js', () => ({
      runProviderConnectCommand: vi.fn(async () => 0),
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getAllConversationRoutes: vi.fn(async () => ({
          'slack:C123': { name: 'Main Agent', folder: 'main_agent' },
        })),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(1);
    // The only write is the rollback restoring pre-connect channel state.
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'cli:setup-add-agent-rollback' }),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('No conversation was bound to the new agent'),
    );
  });

  it('does not override CLI settings storage resolution when URL lives in runtime .env', async () => {
    const runtimeHome = makeRuntimeHome();
    const originalGantryHome = process.env.GANTRY_HOME;
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    delete process.env.GANTRY_DATABASE_URL;
    process.env.GANTRY_HOME = runtimeHome;
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_DATABASE_URL=postgres://user:pass@localhost:5432/gantry\n',
    );
    let storageProvider:
      | Parameters<
          (typeof import('@core/config/settings/runtime-settings.js'))['configureDesiredSettingsStorageProvider']
        >[0]
      | undefined;
    const initializeRuntimeStorage = vi.fn(async () => ({
      ops: {},
      repositories: { settingsRevisions: {} },
      service: { pool: {} },
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn((provider) => {
        storageProvider = provider;
      }),
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      getRuntimeStorage: vi.fn(() => {
        throw new Error('runtime storage not initialized');
      }),
      initializeRuntimeStorage,
      isStorageUnavailableError: vi.fn(() => false),
    }));

    try {
      await import('@core/cli/index.js');
      await storageProvider?.({
        settings: {
          storage: {
            postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
          },
        },
      } as any);
    } finally {
      if (originalGantryHome === undefined) {
        delete process.env.GANTRY_HOME;
      } else {
        process.env.GANTRY_HOME = originalGantryHome;
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
    }

    expect(initializeRuntimeStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSettings: expect.objectContaining({
          storage: {
            postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
          },
        }),
      }),
    );
    expect(initializeRuntimeStorage.mock.calls[0]?.[0]).not.toHaveProperty(
      'storageConfig',
    );
  });

  it('bypasses top-level settings validation for local status and prints Compose guidance', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'storage: nope\n',
    );
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'local', 'status']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker-compose.yml'),
      'Local Status',
    );
  });

  it('lets runtime startup handle revision authority before start preflight', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'agent:\n  name: broken\nagent:\n  name: duplicate\n',
    );
    const startGantryRuntime = vi.fn(async () => undefined);
    const runPostgresMigrations = vi.fn(async () => undefined);
    const validateRuntimePreflightWithStorage = vi.fn(() => {
      throw new Error('CLI start should not preflight settings.yaml directly');
    });
    vi.doMock('@core/app/index.js', () => ({ startGantryRuntime }));
    vi.doMock('@core/postgres-migrate.js', () => ({ runPostgresMigrations }));
    vi.doMock('@core/config/preflight.js', () => ({
      validateRuntimePreflightWithStorage,
      formatRuntimePreflightFailure: vi.fn(),
    }));
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
    };
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log,
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'start']);

    expect(code).toBe(0);
    expect(runPostgresMigrations).toHaveBeenCalledBefore(startGantryRuntime);
    expect(startGantryRuntime).toHaveBeenCalledWith();
    expect(validateRuntimePreflightWithStorage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'gantry start runs the runtime in the FOREGROUND. Manage the background service with `gantry service install` and `gantry restart`.',
    );
  });

  it('runs migrations before smart CLI status checks', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(path.join(runtimeHome, 'settings.yaml'), 'agent: {}\n');
    const runPostgresMigrations = vi.fn(async () => undefined);
    const validateRuntimePreflightWithStorage = vi.fn(async () => ({
      ok: true,
    }));
    const hasRuntimeConfig = vi.fn(() => true);
    const hasProcessableGroupForConfiguredChannel = vi.fn(async () => true);
    const collectRuntimeStatus = vi.fn(async () => ({ doctor: { ok: true } }));
    const formatRuntimeStatus = vi.fn(() => 'ready');
    const note = vi.fn();
    vi.doMock('@core/postgres-migrate.js', () => ({ runPostgresMigrations }));
    vi.doMock('@core/config/preflight.js', () => ({
      validateRuntimePreflightWithStorage,
    }));
    vi.doMock('@core/cli/doctor.js', () => ({
      hasRuntimeConfig,
      hasProcessableGroupForConfiguredChannel,
    }));
    vi.doMock('@core/cli/status.js', () => ({
      collectRuntimeStatus,
      formatRuntimeStatus,
    }));
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome]);

    expect(code).toBe(0);
    expect(runPostgresMigrations).toHaveBeenCalledBefore(
      validateRuntimePreflightWithStorage,
    );
    expect(note).toHaveBeenCalledWith('ready', 'Status');
  });

  it('does not stop local Docker services from the Gantry CLI', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    const code = await runLocalCommand(runtimeHome, ['stop']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker compose stop'),
      'Local Stop',
    );
  });

  it('points local logs to docker compose without requiring configured services', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    const code = await runLocalCommand(runtimeHome, ['logs']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker compose logs'),
      'Local Logs',
    );
  });

  it('routes top-level channel commands to the channel command family', async () => {
    const runtimeHome = makeRuntimeHome();
    const runProviderCommand = vi.fn(async () => 0);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn(),
      ensureRuntimeSettings: vi.fn(),
      readRuntimeMemorySettingsSnapshot: vi.fn(() => ({
        memoryEnabled: false,
        storage: {
          postgresUrlEnv: 'GANTRY_DATABASE_URL',
          postgresSchema: 'gantry',
        },
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: 'text-embedding-3-small',
        },
        dreaming: { enabled: false },
        llmModels: {
          extractor: 'haiku',
          dreaming: 'sonnet',
          consolidation: 'sonnet',
        },
      })),
      readRuntimeStorageSettingsSnapshot: vi.fn(() => ({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      })),
    }));
    vi.doMock('@core/cli/provider.js', () => ({
      runProviderCommand: runProviderCommand,
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main([
      '--runtime-home',
      runtimeHome,
      'provider',
      'connect',
      'telegram',
    ]);

    expect(code).toBe(0);
    expect(runProviderCommand).toHaveBeenCalledWith(
      expect.any(String),
      runtimeHome,
      ['connect', 'telegram'],
    );
  });

  it('sets GANTRY_HOME from --runtime-home before lazy command imports', async () => {
    const runtimeHome = makeRuntimeHome();
    const originalGantryHome = process.env.GANTRY_HOME;
    delete process.env.GANTRY_HOME;
    const runModelCommand = vi.fn(async () => {
      expect(process.env.GANTRY_HOME).toBe(runtimeHome);
      return 0;
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn(),
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/cli/model.js', () => ({ runModelCommand }));

    try {
      const { main } = await import('@core/cli/index.js');
      const code = await main(['--runtime-home', runtimeHome, 'model', 'list']);

      expect(code).toBe(0);
      expect(runModelCommand).toHaveBeenCalledWith(runtimeHome, ['list']);
    } finally {
      if (originalGantryHome === undefined) {
        delete process.env.GANTRY_HOME;
      } else {
        process.env.GANTRY_HOME = originalGantryHome;
      }
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

const events: string[] = [];
const settingsWrites: Array<{
  schema: string;
  previousSchema?: string;
  telegramEnabled: boolean;
  telegramBotRef?: string;
  agentHarness: string;
}> = [];
const desiredSettings = createDefaultRuntimeSettings();

vi.mock('@core/config/env/file.js', () => ({
  readEnvFile: vi.fn(() => ({})),
  upsertEnvFile: vi.fn(),
}));

vi.mock('@core/config/settings/runtime-home.js', () => ({
  envFilePath: vi.fn(() => '/tmp/gantry/.env'),
  ensureRuntimeLayout: vi.fn(),
}));

vi.mock('@core/cli/credentials.js', () => ({
  storeRuntimeSecretInput: vi.fn(async (input: { name: string }) => {
    events.push(`secret:${input.name}`);
  }),
}));

vi.mock('@core/postgres-migrate.js', () => ({
  runPostgresMigrations: vi.fn(
    async (input: { url: string; schema: string }) => {
      events.push(`migrate:${input.schema}`);
    },
  ),
}));

vi.mock('@core/config/settings/runtime-settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@core/config/settings/runtime-settings.js')
    >();
  return {
    ...actual,
    loadRuntimeSettings: vi.fn(() => createDefaultRuntimeSettings()),
    loadDesiredRuntimeSettingsForWrite: vi.fn(
      (input: {
        settings?: ReturnType<typeof createDefaultRuntimeSettings>;
      }) => {
        events.push(
          `loadDesired:${input.settings?.storage.postgres.schema ?? 'none'}`,
        );
        return structuredClone(desiredSettings);
      },
    ),
    writeDesiredRuntimeSettings: vi.fn(
      async (input: {
        settings: ReturnType<typeof createDefaultRuntimeSettings>;
        previousSettings?: ReturnType<typeof createDefaultRuntimeSettings>;
      }) => {
        events.push(`write:${input.settings.storage.postgres.schema}`);
        settingsWrites.push({
          schema: input.settings.storage.postgres.schema,
          previousSchema: input.previousSettings?.storage.postgres.schema,
          telegramEnabled: Boolean(input.settings.providers.telegram.enabled),
          telegramBotRef:
            input.settings.providerConnections.telegram_default
              ?.runtimeSecretRefs.bot_token,
          agentHarness: input.settings.agent.agentHarness,
        });
        return { reconciled: false };
      },
    ),
  };
});

describe('persistOnboardingConfig', () => {
  beforeEach(() => {
    events.length = 0;
    settingsWrites.length = 0;
    Object.assign(desiredSettings, createDefaultRuntimeSettings());
  });

  it('persists the selected storage schema before writing repository runtime secrets', async () => {
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      postgresDatabaseUrl:
        'postgres://user:pass@127.0.0.1:5432/gantry?schema=custom_schema',
      postgresSchema: 'custom_schema',
      primaryProvider: 'telegram',
      telegramBotToken: '123456:abcdef',
      agentHarness: 'deepagents',
      credentialMode: 'none',
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(events).toEqual([
      'migrate:custom_schema',
      'loadDesired:custom_schema',
      'write:custom_schema',
      'secret:TELEGRAM_BOT_TOKEN',
      'write:custom_schema',
    ]);
    expect(settingsWrites[0]?.telegramEnabled).toBe(false);
    expect(settingsWrites[0]?.telegramBotRef).toBeUndefined();
    expect(settingsWrites[1]?.telegramEnabled).toBe(true);
    expect(settingsWrites[1]?.telegramBotRef).toBe(
      'gantry-secret:TELEGRAM_BOT_TOKEN',
    );
    expect(settingsWrites[1]?.previousSchema).toBe('custom_schema');
    expect(settingsWrites[1]?.agentHarness).toBe('deepagents');
  });

  it('does not persist partial settings before model validation fails', async () => {
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await expect(
      persistOnboardingConfig({
        runtimeHome: '/tmp/gantry',
        postgresDatabaseUrl:
          'postgres://user:pass@127.0.0.1:5432/gantry?schema=custom_schema',
        postgresSchema: 'custom_schema',
        primaryProvider: 'telegram',
        telegramBotToken: '123456:abcdef',
        modelAlias: 'not-a-model',
        credentialMode: 'none',
        memoryEnabled: false,
        embeddingsEnabled: false,
        dreamingEnabled: false,
      }),
    ).rejects.toThrow('Unknown model');

    expect(events).toEqual([]);
    expect(settingsWrites).toEqual([]);
  });

  it('starts from latest desired state before onboarding writes', async () => {
    desiredSettings.agent.name = 'Latest Desired Agent';
    desiredSettings.storage.postgres.schema = 'latest_schema';
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      postgresDatabaseUrl:
        'postgres://user:pass@127.0.0.1:5432/gantry?schema=custom_schema',
      postgresSchema: 'custom_schema',
      primaryProvider: 'telegram',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: true,
      dreamingEnabled: true,
    });

    expect(settingsWrites.at(-1)).toMatchObject({
      schema: 'custom_schema',
      previousSchema: 'latest_schema',
      agentHarness: 'auto',
    });
  });
});

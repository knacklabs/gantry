import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

const events: string[] = [];
const settingsWrites: Array<{
  schema: string;
  previousSchema?: string;
  telegramEnabled: boolean;
  telegramBotRef?: string;
  slackEnabled: boolean;
  slackBotRef?: string;
  slackAppRef?: string;
  agentHarness: string;
  defaultModel: string;
  oneTimeJobDefaultModel: string;
  memoryExtractor: string;
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
            input.settings.providerAccounts.telegram_default?.runtimeSecretRefs
              .bot_token,
          slackEnabled: Boolean(input.settings.providers.slack.enabled),
          slackBotRef:
            input.settings.providerAccounts.slack_default?.runtimeSecretRefs
              .bot_token,
          slackAppRef:
            input.settings.providerAccounts.slack_default?.runtimeSecretRefs
              .app_token,
          agentHarness: input.settings.agent.agentHarness,
          defaultModel: input.settings.agent.defaultModel,
          oneTimeJobDefaultModel: input.settings.agent.oneTimeJobDefaultModel,
          memoryExtractor: input.settings.memory.llm.models.extractor,
        });
        return { reconciled: false };
      },
    ),
  };
});

describe('persistOnboardingConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('preserves an enabled provider with stored refs when no new token is supplied', async () => {
    desiredSettings.providers.slack.enabled = true;
    desiredSettings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {
        bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
        app_token: 'gantry-secret:SLACK_APP_TOKEN',
      },
    };
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      primaryProvider: 'slack',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(events).toEqual(['loadDesired:gantry', 'write:gantry']);
    expect(settingsWrites.at(-1)).toMatchObject({
      slackEnabled: true,
      slackBotRef: 'gantry-secret:SLACK_BOT_TOKEN',
      slackAppRef: 'gantry-secret:SLACK_APP_TOKEN',
    });
  });

  it('does not scrub env-backed refs for a preserved enabled provider', async () => {
    desiredSettings.providers.slack.enabled = true;
    desiredSettings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {
        bot_token: 'env:SLACK_BOT_TOKEN',
        app_token: 'env:SLACK_APP_TOKEN',
      },
    };
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');
    const { upsertEnvFile } = await import('@core/config/env/file.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      primaryProvider: 'slack',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(settingsWrites.at(-1)).toMatchObject({
      slackEnabled: true,
      slackBotRef: 'env:SLACK_BOT_TOKEN',
      slackAppRef: 'env:SLACK_APP_TOKEN',
    });
    expect(vi.mocked(upsertEnvFile).mock.calls.at(-1)?.[1]).toEqual({
      TELEGRAM_BOT_TOKEN: null,
      SLACK_PERMISSION_APPROVER_IDS: null,
    });
  });

  it('keeps the other configured channel enabled when a different primary is persisted', async () => {
    desiredSettings.providers.slack.enabled = true;
    desiredSettings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {
        bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
        app_token: 'gantry-secret:SLACK_APP_TOKEN',
      },
    };
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      primaryProvider: 'telegram',
      telegramBotToken: '12345:telegram-token',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(settingsWrites.at(-1)).toMatchObject({
      telegramEnabled: true,
      slackEnabled: true,
    });
  });

  it('preserves job and memory customizations when the chat model is unchanged', async () => {
    desiredSettings.agent.defaultModel = 'kimi';
    desiredSettings.agent.oneTimeJobDefaultModel = 'haiku';
    desiredSettings.memory.llm.models.extractor = 'haiku';
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      primaryProvider: 'telegram',
      modelAlias: 'kimi',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(settingsWrites.at(-1)).toMatchObject({
      defaultModel: 'kimi',
      oneTimeJobDefaultModel: 'haiku',
      memoryExtractor: 'haiku',
    });
  });

  it('carries a family chat alias through a non-model maintenance save', async () => {
    desiredSettings.agent.defaultModel = 'gpt-oss';
    desiredSettings.agent.oneTimeJobDefaultModel = 'haiku';
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      primaryProvider: 'telegram',
      modelAlias: 'gpt-oss',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(settingsWrites.at(-1)).toMatchObject({
      defaultModel: 'gpt-oss',
      oneTimeJobDefaultModel: 'haiku',
    });
  });

  it('re-derives defaults when the chat model changes', async () => {
    desiredSettings.agent.defaultModel = 'kimi';
    desiredSettings.agent.oneTimeJobDefaultModel = 'haiku';
    const { persistOnboardingConfig } =
      await import('@core/cli/onboarding-config.js');

    await persistOnboardingConfig({
      runtimeHome: '/tmp/gantry',
      primaryProvider: 'telegram',
      modelAlias: 'sonnet',
      agentHarness: 'auto',
      credentialMode: 'gantry',
      memoryEnabled: true,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    });

    expect(settingsWrites.at(-1)).toMatchObject({
      defaultModel: 'sonnet',
      oneTimeJobDefaultModel: '',
    });
  });
});

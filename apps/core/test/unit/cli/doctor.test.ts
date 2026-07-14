import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockListModelCredentials = vi.hoisted(() => vi.fn());
const mockGetCapabilitySecret = vi.hoisted(() => vi.fn());
const mockValidateTelegramBotToken = vi.hoisted(() => vi.fn());
const mockValidateSlackBotToken = vi.hoisted(() => vi.fn());
const mockValidateSlackAppToken = vi.hoisted(() => vi.fn());
const mockInspectRuntimeSecretReadiness = vi.hoisted(() => vi.fn());
const mockVerifyModelProviderCredentialLive = vi.hoisted(() => vi.fn());

vi.mock(
  '@core/application/model-credentials/model-credential-service.js',
  () => ({
    ModelCredentialService: class MockModelCredentialService {
      async list(input: unknown) {
        return (await mockListModelCredentials(input)).map(
          (row: { status?: string; health?: string }) => ({
            ...row,
            health:
              row.health ?? (row.status === 'active' ? 'ready' : 'missing'),
          }),
        );
      }

      async getActiveCredential(input: { appId: string; providerId: string }) {
        const row = (await mockListModelCredentials(input)).find(
          (item: { providerId: string }) =>
            item.providerId === input.providerId,
        );
        if (!row || row.status !== 'active') return null;
        return {
          ...row,
          authMode: row.authMode ?? 'api_key',
          payload: row.payload ?? { apiKey: `${input.providerId}-key` },
        };
      }
    },
  }),
);

vi.mock(
  '@core/application/model-resolution/required-model-credential-providers.js',
  () => ({
    requiredModelCredentialProviders: vi.fn((settings) => {
      const providers = new Set<string>(['anthropic']);
      if (
        settings.memory.embeddings.enabled &&
        settings.memory.embeddings.provider !== 'disabled'
      ) {
        providers.add(settings.memory.embeddings.provider);
      }
      if (
        settings.memory.dreaming.embeddings.enabled &&
        settings.memory.dreaming.embeddings.provider !== 'disabled'
      ) {
        providers.add(settings.memory.dreaming.embeddings.provider);
      }
      return [...providers].sort();
    }),
  }),
);

vi.mock('@core/infrastructure/service/package-paths.js', () => ({
  assertRuntimeEntryExists: vi.fn(),
  getRuntimeEntryPath: () => '/mock/dist/index.js',
}));

vi.mock('@core/infrastructure/service/platform.js', () => ({
  commandExists: vi.fn(() => true),
  detectPlatform: vi.fn(() => 'macos'),
  getNodeMajorVersion: vi.fn(() => 25),
  getNodeVersion: vi.fn(() => '25.0.0'),
  hasSystemdUser: vi.fn(() => false),
}));

vi.mock('@core/cli/telegram.js', () => ({
  validateTelegramBotToken: mockValidateTelegramBotToken,
}));

vi.mock('@core/cli/slack.js', () => ({
  validateSlackBotToken: mockValidateSlackBotToken,
  validateSlackAppToken: mockValidateSlackAppToken,
}));

vi.mock('@core/cli/model-credential-verify.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@core/cli/model-credential-verify.js')
    >();
  return {
    ...actual,
    verifyModelProviderCredentialLive: mockVerifyModelProviderCredentialLive,
  };
});

vi.mock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
  inspectRuntimeStorageReadiness: vi.fn(async () => ({
    status: 'pass',
    message: 'Postgres is ready.',
  })),
  inspectRuntimeSecretReadiness: mockInspectRuntimeSecretReadiness,
}));

vi.mock('@core/adapters/storage/postgres/factory.js', () => ({
  createStorageRuntime: vi.fn(() => ({
    service: {
      close: vi.fn(async () => undefined),
    },
    runtimeEventNotifier: {
      close: vi.fn(async () => undefined),
    },
    repositories: {
      modelCredentials: {
        listModelCredentials: mockListModelCredentials,
      },
      capabilitySecrets: {
        getSecret: mockGetCapabilitySecret,
      },
    },
  })),
}));

const runtimeHomes: string[] = [];
const strongEncryptionKey = Buffer.from(
  '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
  'hex',
).toString('base64');

function makeRuntimeHome(options?: {
  embeddingsEnabled?: boolean;
  dreamingEmbeddingsEnabled?: boolean;
  sandboxProvider?: 'direct' | 'sandbox_runtime';
  keyringOnly?: boolean;
}): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-doctor-'));
  runtimeHomes.push(runtimeHome);
  fs.writeFileSync(
    path.join(runtimeHome, '.env'),
    [
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
      ...(options?.keyringOnly
        ? [
            `SECRET_ENCRYPTION_KEYRING_JSON=${JSON.stringify({
              active: 'primary',
              keys: { primary: strongEncryptionKey },
            })}`,
          ]
        : [`SECRET_ENCRYPTION_KEY=${strongEncryptionKey}`]),
      'TELEGRAM_BOT_TOKEN=123456:test-token',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(runtimeHome, 'settings.yaml'),
    [
      'providers:',
      '  telegram:',
      '    enabled: true',
      'storage:',
      '  postgres:',
      '    url_env: GANTRY_DATABASE_URL',
      '    schema: gantry',
      'model_access:',
      '  enabled: true',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      `    enabled: ${options?.embeddingsEnabled ? 'true' : 'false'}`,
      `    provider: ${options?.embeddingsEnabled ? 'openai' : 'disabled'}`,
      '    model: text-embedding-3-small',
      '  dreaming:',
      '    enabled: false',
      '    embeddings:',
      `      enabled: ${options?.dreamingEmbeddingsEnabled ? 'true' : 'false'}`,
      `      provider: ${options?.dreamingEmbeddingsEnabled ? 'openai' : 'disabled'}`,
      '      model: text-embedding-3-small',
      '  llm:',
      '    models:',
      '      extractor: haiku',
      '      dreaming: sonnet',
      '      consolidation: sonnet',
      ...(options?.sandboxProvider
        ? ['runtime:', '  sandbox:', `    provider: ${options.sandboxProvider}`]
        : []),
      '',
    ].join('\n'),
  );
  return runtimeHome;
}

afterEach(() => {
  mockListModelCredentials.mockReset();
  mockGetCapabilitySecret.mockReset();
  mockValidateTelegramBotToken.mockReset();
  mockValidateSlackBotToken.mockReset();
  mockValidateSlackAppToken.mockReset();
  mockInspectRuntimeSecretReadiness.mockReset();
  mockVerifyModelProviderCredentialLive.mockReset();
  vi.resetModules();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('doctor model credential readiness', () => {
  beforeEach(() => {
    mockInspectRuntimeSecretReadiness.mockResolvedValue({
      status: 'pass',
      message: 'Runtime secret refs are ready.',
    });
    mockVerifyModelProviderCredentialLive.mockResolvedValue({ ok: true });
  });

  it('accepts the fleet rehearsal postgres service hostname in runtime storage checks', async () => {
    mockListModelCredentials.mockResolvedValue([]);
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'GANTRY_DATABASE_URL=postgres://gantry_app:pass@postgres:5432/gantry',
        'GANTRY_FLEET_REHEARSAL_AUTO_SECRETS=1',
        `SECRET_ENCRYPTION_KEY=${strongEncryptionKey}`,
        'TELEGRAM_BOT_TOKEN=123456:test-token',
        '',
      ].join('\n'),
    );
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'runtime-storage',
        status: 'pass',
      }),
    );
  });

  it('fails when selected model defaults are missing active credentials', async () => {
    mockListModelCredentials.mockResolvedValue([]);
    const runtimeHome = makeRuntimeHome();
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'model-access-credentials',
        status: 'fail',
        message: expect.stringContaining('anthropic'),
        nextAction: expect.stringContaining(
          'gantry credentials model set anthropic',
        ),
      }),
    );
  });

  it('validates Telegram through stored runtime secrets when env token is absent', async () => {
    mockListModelCredentials.mockResolvedValue([]);
    mockGetCapabilitySecret.mockResolvedValue({
      value: '123456:stored-token',
    });
    mockValidateTelegramBotToken.mockResolvedValue({
      ok: true,
      message: 'Telegram token is valid.',
    });
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
        `SECRET_ENCRYPTION_KEY=${strongEncryptionKey}`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      [
        'providers:',
        '  telegram:',
        '    enabled: true',
        'provider_accounts:',
        '  telegram_default:',
        '    agent: main_agent',
        '    provider: telegram',
        '    label: Telegram',
        '    runtime_secret_refs:',
        '      bot_token: gantry-secret:TELEGRAM_BOT_TOKEN',
        'agents:',
        '  main_agent:',
        '    name: Main',
        'storage:',
        '  postgres:',
        '    url_env: GANTRY_DATABASE_URL',
        '    schema: gantry',
        'model_access:',
        '  enabled: true',
        'memory:',
        '  enabled: true',
        '  embeddings:',
        '    enabled: false',
        '    provider: disabled',
        '    model: text-embedding-3-small',
        '  dreaming:',
        '    enabled: false',
        '    embeddings:',
        '      enabled: false',
        '      provider: disabled',
        '      model: text-embedding-3-small',
        '  llm:',
        '    models:',
        '      extractor: haiku',
        '      dreaming: sonnet',
        '      consolidation: sonnet',
        '',
      ].join('\n'),
    );
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    await runDoctorWithNetwork(import.meta.url, runtimeHome);

    expect(mockGetCapabilitySecret).toHaveBeenCalledWith({
      appId: 'default',
      name: 'TELEGRAM_BOT_TOKEN',
    });
    expect(mockValidateTelegramBotToken).toHaveBeenCalledWith(
      '123456:stored-token',
      undefined,
    );
  });

  it('does not pass unresolved stored Slack runtime secrets', async () => {
    mockListModelCredentials.mockResolvedValue([]);
    mockInspectRuntimeSecretReadiness.mockResolvedValue({
      status: 'fail',
      message: 'Runtime secret preflight failed.',
      details: [
        'provider_accounts.slack_default.provider slack runtime_secret_refs.bot_token runtime secret ref gantry-secret:SLACK_BOT_TOKEN did not resolve.',
      ],
    });
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      [
        'providers:',
        '  slack:',
        '    enabled: true',
        'provider_accounts:',
        '  slack_default:',
        '    agent: main_agent',
        '    provider: slack',
        '    label: Slack',
        '    runtime_secret_refs:',
        '      bot_token: gantry-secret:SLACK_BOT_TOKEN',
        '      app_token: gantry-secret:SLACK_APP_TOKEN',
        'agents:',
        '  main_agent:',
        '    name: Main',
        'storage:',
        '  postgres:',
        '    url_env: GANTRY_DATABASE_URL',
        '    schema: gantry',
        'model_access:',
        '  enabled: true',
        'memory:',
        '  enabled: true',
        '  embeddings:',
        '    enabled: false',
        '    provider: disabled',
        '    model: text-embedding-3-small',
        '  dreaming:',
        '    enabled: false',
        '    embeddings:',
        '      enabled: false',
        '      provider: disabled',
        '      model: text-embedding-3-small',
        '  llm:',
        '    models:',
        '      extractor: haiku',
        '      dreaming: sonnet',
        '      consolidation: sonnet',
        '',
      ].join('\n'),
    );
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'slack-tokens',
        status: 'warn',
        nextAction:
          're-run `gantry provider connect slack`, then `gantry restart`',
      }),
    );
  });

  it('passes when selected model defaults have active credentials', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome();
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'model-access-credentials',
        status: 'pass',
        message: expect.stringContaining('anthropic'),
      }),
    );
  });

  it('downgrades ready model credentials when live verification rejects them', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        payload: { apiKey: 'bad-key' },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    mockVerifyModelProviderCredentialLive.mockResolvedValue({
      ok: false,
      message:
        'Anthropic credential verification failed with HTTP 401: bad key',
    });
    const runtimeHome = makeRuntimeHome();
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'model-access-credentials',
        status: 'fail',
        message: expect.stringContaining('HTTP 401'),
        nextAction: 'gantry credentials model set anthropic',
      }),
    );
  });

  it('skips live model probes only for setup skip-listed providers', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'model-credential:default:openai',
        appId: 'default',
        providerId: 'openai',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:openai',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ embeddingsEnabled: true });
    const { ensureRuntimeSettings } =
      await import('@core/config/settings/runtime-settings.js');
    const { inspectModelCredentialReadiness } =
      await import('@core/cli/model-credential-readiness.js');

    const check = await inspectModelCredentialReadiness(
      runtimeHome,
      ensureRuntimeSettings(runtimeHome),
      { live: true, skipLiveProviderIds: ['anthropic'] },
    );

    expect(check.status).toBe('pass');
    expect(mockVerifyModelProviderCredentialLive).toHaveBeenCalledTimes(1);
    expect(mockVerifyModelProviderCredentialLive).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai' }),
    );
  });

  it('validates Slack bot and app tokens in network doctor', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    mockValidateSlackBotToken.mockResolvedValue({
      ok: true,
      message: 'bot ok',
    });
    mockValidateSlackAppToken.mockResolvedValue({
      ok: true,
      message: 'app ok',
    });
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
        `SECRET_ENCRYPTION_KEY=${strongEncryptionKey}`,
        'SLACK_BOT_TOKEN=xoxb-valid',
        'SLACK_APP_TOKEN=xapp-valid',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      [
        'providers:',
        '  slack:',
        '    enabled: true',
        'provider_accounts:',
        '  slack_default:',
        '    agent: main_agent',
        '    provider: slack',
        '    label: Slack',
        '    runtime_secret_refs:',
        '      bot_token: env:SLACK_BOT_TOKEN',
        '      app_token: env:SLACK_APP_TOKEN',
        'agents:',
        '  main_agent:',
        '    name: Main',
        'storage:',
        '  postgres:',
        '    url_env: GANTRY_DATABASE_URL',
        '    schema: gantry',
        'model_access:',
        '  enabled: true',
        'memory:',
        '  enabled: true',
        '  embeddings:',
        '    enabled: false',
        '    provider: disabled',
        '    model: text-embedding-3-small',
        '  dreaming:',
        '    enabled: false',
        '    embeddings:',
        '      enabled: false',
        '      provider: disabled',
        '      model: text-embedding-3-small',
        '  llm:',
        '    models:',
        '      extractor: haiku',
        '      dreaming: sonnet',
        '      consolidation: sonnet',
        '',
      ].join('\n'),
    );
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(mockValidateSlackBotToken).toHaveBeenCalledWith(
      'xoxb-valid',
      undefined,
    );
    expect(mockValidateSlackAppToken).toHaveBeenCalledWith(
      'xapp-valid',
      undefined,
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'slack-token-api',
        status: 'pass',
      }),
    );
  });

  it('skips Slack live token validation when disabled', async () => {
    mockListModelCredentials.mockResolvedValue([]);
    const runtimeHome = makeRuntimeHome();
    fs.appendFileSync(
      path.join(runtimeHome, '.env'),
      ['SLACK_BOT_TOKEN=xoxb-valid', 'SLACK_APP_TOKEN=xapp-valid', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      [
        'providers:',
        '  slack:',
        '    enabled: true',
        'provider_accounts:',
        '  slack_default:',
        '    agent: main_agent',
        '    provider: slack',
        '    label: Slack',
        '    runtime_secret_refs:',
        '      bot_token: env:SLACK_BOT_TOKEN',
        '      app_token: env:SLACK_APP_TOKEN',
        'model_access:',
        '  enabled: true',
        '',
      ].join('\n'),
    );
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
      validateSlackToken: false,
    });

    expect(mockValidateSlackBotToken).not.toHaveBeenCalled();
    expect(mockValidateSlackAppToken).not.toHaveBeenCalled();
  });

  it('accepts keyring-only model credential encryption in doctor output', async () => {
    mockListModelCredentials.mockResolvedValue([]);
    const runtimeHome = makeRuntimeHome({ keyringOnly: true });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'model-credential-encryption',
        status: 'pass',
        message: expect.stringContaining('SECRET_ENCRYPTION_KEYRING_JSON'),
      }),
    );
  });

  it('reports direct runner sandbox compatibility mode', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ sandboxProvider: 'direct' });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'runner-sandbox',
        status: 'pass',
        message: expect.stringContaining('no outer OS sandbox'),
      }),
    );
    expect(
      report.checks.find((check) => check.id === 'runner-sandbox')?.message,
    ).toContain('not organisation-safe');
    expect(
      report.checks.find((check) => check.id === 'runner-sandbox')?.message,
    ).toContain(
      'Setup required: sandbox_runtime is required for safe-host execution.',
    );
  });

  it('reports sandbox_runtime as available when OS support is present', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ sandboxProvider: 'sandbox_runtime' });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'runner-sandbox',
        status: 'pass',
        message: expect.stringContaining('sandbox_runtime is configured'),
      }),
    );
    expect(
      report.checks.find((check) => check.id === 'runner-sandbox')?.message,
    ).toContain('honor standard proxy env');
  });

  it('fails Linux sandbox_runtime readiness when socat is missing', async () => {
    const platform = await import('@core/infrastructure/service/platform.js');
    vi.mocked(platform.detectPlatform).mockReturnValue('linux');
    vi.mocked(platform.commandExists).mockImplementation(
      (command: string) => command !== 'socat',
    );
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ sandboxProvider: 'sandbox_runtime' });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'runner-sandbox',
        status: 'fail',
        message: expect.stringContaining('socat'),
      }),
    );
  });

  it('fails sandbox_runtime readiness when ripgrep is missing', async () => {
    const platform = await import('@core/infrastructure/service/platform.js');
    vi.mocked(platform.detectPlatform).mockReturnValue('linux');
    vi.mocked(platform.commandExists).mockImplementation(
      (command: string) => command !== 'rg',
    );
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ sandboxProvider: 'sandbox_runtime' });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'runner-sandbox',
        status: 'fail',
        message: expect.stringContaining('ripgrep'),
      }),
    );
  });

  it('does not require ripgrep for macOS sandbox_runtime readiness', async () => {
    const platform = await import('@core/infrastructure/service/platform.js');
    vi.mocked(platform.detectPlatform).mockReturnValue('macos');
    vi.mocked(platform.commandExists).mockImplementation(
      (command: string) => command !== 'rg',
    );
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ sandboxProvider: 'sandbox_runtime' });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'runner-sandbox',
        status: 'pass',
        message: expect.stringContaining('sandbox_runtime is configured'),
      }),
    );
  });

  it('fails when enabled OpenAI embeddings are missing credentials', async () => {
    const now = new Date().toISOString();
    mockListModelCredentials.mockResolvedValue([
      {
        id: 'model-credential:default:anthropic',
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:anthropic',
        fieldFingerprints: [{ field: 'apiKey', fingerprint: 'sha256:field' }],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const runtimeHome = makeRuntimeHome({ embeddingsEnabled: true });
    const { runDoctorWithNetwork } = await import('@core/cli/doctor.js');

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'model-access-credentials',
        status: 'fail',
        message: expect.stringContaining('openai'),
        nextAction: expect.stringContaining(
          'gantry credentials model set openai',
        ),
      }),
    );
  });
});

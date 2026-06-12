import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockListModelCredentials = vi.hoisted(() => vi.fn());

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

vi.mock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
  inspectRuntimeStorageReadiness: vi.fn(async () => ({
    status: 'pass',
    message: 'Postgres is ready.',
  })),
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
  vi.resetModules();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('doctor model credential readiness', () => {
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

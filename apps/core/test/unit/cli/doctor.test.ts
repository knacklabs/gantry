import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(envLines: string[] = []): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-doctor-'));
  runtimeHomes.push(runtimeHome);
  fs.writeFileSync(path.join(runtimeHome, '.env'), `${envLines.join('\n')}\n`);
  fs.writeFileSync(
    path.join(runtimeHome, 'settings.yaml'),
    [
      'providers:',
      '  telegram:',
      '    enabled: false',
      '  slack:',
      '    enabled: false',
      'storage:',
      '  postgres:',
      '    url_env: GANTRY_DATABASE_URL',
      '    schema: gantry',
      'credential_broker:',
      '  mode: onecli',
      '  onecli:',
      '    url: http://localhost:10254',
      '    postgres:',
      '      url_env: ONECLI_DATABASE_URL',
      '      schema: onecli',
      '  external:',
      '    base_url: ""',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      '  llm:',
      '    models:',
      '      extractor: haiku',
      '      dreaming: sonnet',
      '      consolidation: sonnet',
      '',
    ].join('\n'),
  );
  return runtimeHome;
}

function setCredentialBrokerSettings(
  runtimeHome: string,
  mode: 'none' | 'onecli' | 'external',
  externalBaseUrl = '',
): void {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  fs.writeFileSync(
    settingsPath,
    raw
      .replace('  mode: onecli', `  mode: ${mode}`)
      .replace(
        '  external:\n    base_url: ""',
        `  external:\n    base_url: ${externalBaseUrl ? externalBaseUrl : '""'}`,
      ),
  );
}

function enableChannel(runtimeHome: string, channelId: string): void {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  const settings = fs.readFileSync(settingsPath, 'utf-8');
  fs.writeFileSync(
    settingsPath,
    settings.replace(
      `  ${channelId}:\n    enabled: false`,
      `  ${channelId}:\n    enabled: true`,
    ),
  );
}

async function loadDoctor(options?: {
  onecliEnv?: Record<string, string>;
  onecliPersistence?: { status: string; message: string };
  onOnecliConstruct?: (options: unknown) => void;
  runtimeGroupCount?: number;
  nodeMajor?: number;
  nodeVersion?: string;
}) {
  const getContainerConfig = vi.fn(async () => ({
    env: options?.onecliEnv || {},
  }));
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: vi.fn(function (clientOptions: unknown) {
      options?.onOnecliConstruct?.(clientOptions);
      return { getContainerConfig };
    }),
  }));
  vi.doMock('@core/infrastructure/service/package-paths.js', () => ({
    assertRuntimeEntryExists: vi.fn(),
    getRuntimeEntryPath: () => '/mock/dist/index.js',
  }));
  vi.doMock('@core/infrastructure/service/platform.js', () => ({
    commandExists: vi.fn(() => true),
    detectPlatform: vi.fn(() => 'macos'),
    getNodeMajorVersion: vi.fn(() => options?.nodeMajor ?? 25),
    getNodeVersion: vi.fn(() => options?.nodeVersion ?? '25.0.0'),
    hasSystemdUser: vi.fn(() => false),
  }));
  vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
    inspectRuntimeStorageReadiness: vi.fn(async () => ({
      status: 'pass',
      message: 'Postgres is ready.',
    })),
  }));
  vi.doMock('@core/cli/runtime-group-db.js', () => ({
    openRuntimeGroupDb: vi.fn(async () => ({
      countConversationRoutesByJidPrefix: vi.fn(
        async () => options?.runtimeGroupCount ?? 0,
      ),
      close: vi.fn(async () => {}),
    })),
  }));
  vi.doMock(
    '@core/adapters/credentials/onecli/local/persistence.js',
    async () => {
      const actual = await vi.importActual<any>(
        '@core/adapters/credentials/onecli/local/persistence.js',
      );
      return {
        ...actual,
        inspectOnecliPersistenceReadiness: vi.fn(async () => ({
          status: options?.onecliPersistence?.status || 'pass',
          message: options?.onecliPersistence?.message || 'OneCLI ready.',
        })),
      };
    },
  );
  return import('@core/cli/doctor.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('doctor', () => {
  it('accepts Node 24 because package engines support Node >=24 <26', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    const { runDoctor } = await loadDoctor({
      nodeMajor: 24,
      nodeVersion: '24.12.0',
    });

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'node-version');

    expect(check).toMatchObject({
      status: 'pass',
      message: 'Node 24.12.0 detected.',
    });
  });

  it('rejects Node versions outside the supported engine range', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    const { runDoctor } = await loadDoctor({
      nodeMajor: 26,
      nodeVersion: '26.0.0',
    });

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'node-version');

    expect(check).toMatchObject({
      status: 'fail',
      message: 'Node 26.0.0 detected. Gantry requires Node >=24 <26.',
      nextAction: 'Install Node.js 24 or 25 and run `gantry doctor` again.',
    });
  });

  it('fails external model access when the broker endpoint is missing', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    setCredentialBrokerSettings(runtimeHome, 'external');
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'fail',
      message:
        'External credential mode requires credential_broker.external.base_url.',
      nextAction: expect.stringContaining(
        'credential_broker.external.base_url',
      ),
    });
  });

  it('prioritizes external broker checks over stale OneCLI URL env', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
      'ONECLI_URL=http://localhost:10254',
    ]);
    setCredentialBrokerSettings(runtimeHome, 'external');
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'fail',
      message:
        'External credential mode requires credential_broker.external.base_url.',
      nextAction: expect.stringContaining(
        'credential_broker.external.base_url',
      ),
    });
  });

  it('reports process env wrong-lane keys in the runtime env boundary check', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-process');
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find(
      (entry) => entry.id === 'runtime-env-boundary',
    );

    expect(check).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('process environment'),
      nextAction: expect.stringContaining(
        'Unset wrong-lane keys from your shell or service environment',
      ),
    });
  });

  it('fails external model access when the broker endpoint URL is unsafe', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://user:pass@broker.example.com',
    );
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'fail',
      message:
        'credential_broker.external.base_url must not contain embedded credentials.',
      nextAction: expect.stringContaining('HTTPS broker URL'),
    });
  });

  it('passes external model access when the broker endpoint is safe', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://broker.example.com/anthropic',
    );
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'pass',
      message: 'Model Access is managed by external credential mode.',
    });
  });

  it('uses runtime-home broker endpoint before ambient process env in doctor', async () => {
    vi.stubEnv(
      'ANTHROPIC_BASE_URL',
      'https://user:pass@ambient-broker.example.com/anthropic',
    );
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://broker.example.com/anthropic',
    );
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'pass',
      message: 'Model Access is managed by external credential mode.',
    });
  });

  it('reports missing OneCLI database configuration with a concrete next action', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find(
      (entry) => entry.id === 'onecli-persistence-config',
    );

    expect(check).toMatchObject({
      status: 'fail',
      message: 'ONECLI_DATABASE_URL is missing.',
    });
    expect(check?.nextAction).toContain('schema=onecli');
  });

  it('fails reachability when OneCLI returns forbidden database secrets', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
      'ONECLI_DATABASE_URL=postgres://onecli_app:pass@localhost:15432/gantry?schema=onecli',
      'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    ]);
    const { runDoctorWithNetwork } = await loadDoctor({
      onecliEnv: { POSTGRES_PASSWORD: 'secret' },
    });

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });
    const check = report.checks.find(
      (entry) => entry.id === 'onecli-reachability',
    );

    expect(check).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('POSTGRES_PASSWORD'),
    });
  });

  it('uses a bounded timeout for OneCLI doctor reachability', async () => {
    const constructedOptions: unknown[] = [];
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
      'ONECLI_DATABASE_URL=postgres://onecli_app:pass@localhost:15432/gantry?schema=onecli',
      'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    ]);
    const { runDoctorWithNetwork } = await loadDoctor({
      onOnecliConstruct: (options) => constructedOptions.push(options),
    });

    await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });

    expect(constructedOptions).toContainEqual({
      url: 'http://localhost:10254',
      timeout: 3_000,
    });
  });

  it('treats process-env channel credentials as processable group readiness', async () => {
    const runtimeHome = makeRuntimeHome([
      'GANTRY_DATABASE_URL=postgres://gantry_app:pass@localhost:15432/gantry',
    ]);
    setCredentialBrokerSettings(runtimeHome, 'none');
    enableChannel(runtimeHome, 'telegram');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:test-token');
    const { hasProcessableGroupForConfiguredChannel } = await loadDoctor({
      runtimeGroupCount: 1,
    });

    await expect(
      hasProcessableGroupForConfiguredChannel(runtimeHome),
    ).resolves.toBe(true);
  });
});

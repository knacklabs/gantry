import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureConfiguredAgent } from '@core/config/settings/runtime-settings.js';

import { createRuntimeHomeFixture } from '../harness/runtime-home-fixture.js';

const fixtures: Array<{ cleanup(): void }> = [];
const strongEncryptionKey = Buffer.from(
  '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
  'hex',
).toString('base64');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fixtures.splice(0).forEach((fixture) => fixture.cleanup());
});

function makeFixture() {
  const fixture = createRuntimeHomeFixture({
    prefix: 'gantry-cli-lifecycle-',
    mutateSettings(settings) {
      settings.providers.slack = {
        enabled: true,
      };
      ensureConfiguredAgent(settings, {
        agentId: 'main_agent',
        agentName: 'Main Agent',
      });
      settings.providerAccounts.slack_default = {
        agentId: 'main_agent',
        provider: 'slack',
        label: 'Test Slack Workspace',
        runtimeSecretRefs: {
          app_token: 'SLACK_APP_TOKEN',
          bot_token: 'SLACK_BOT_TOKEN',
        },
      };
      settings.conversations.slack_test_channel = {
        providerConnection: 'slack_default',
        providerAccount: 'slack_default',
        externalId: 'slack:C0123456789',
        kind: 'channel',
        displayName: 'test-channel',
        senderPolicy: { allow: '*', mode: 'trigger' },
        controlApprovers: ['slack:UADMIN'],
        installedAgents: {
          main_agent: {
            agentId: 'main_agent',
            providerAccountId: 'slack_default',
            status: 'active',
            addedAt: new Date(0).toISOString(),
            memoryScope: 'conversation',
          },
        },
      };
      settings.credentialBroker.mode = 'gantry';
    },
    env: {
      GANTRY_DATABASE_URL: 'postgres://gantry:pass@localhost:15432/gantry',
      SECRET_ENCRYPTION_KEY: strongEncryptionKey,
      SLACK_APP_TOKEN: 'xapp-isolated',
      SLACK_BOT_TOKEN: 'xoxb-isolated',
    },
  });
  fixtures.push(fixture);
  return fixture;
}

async function loadCliWithBoundaryMocks(options?: {
  serviceStatus?: string;
  preflightOk?: boolean;
}) {
  const note = vi.fn();
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  const serviceCalls: Array<{ action: string; runtimeHome: string }> = [];
  vi.doMock('@clack/prompts', () => ({
    note,
    log,
    isCancel: () => false,
    select: vi.fn(),
  }));
  vi.doMock('@core/infrastructure/service/package-paths.js', () => ({
    assertRuntimeEntryExists: vi.fn(),
    getRuntimeEntryPath: () => '/isolated/dist/index.js',
  }));
  vi.doMock('@core/infrastructure/service/platform.js', () => ({
    commandExists: vi.fn(() => true),
    detectPlatform: vi.fn(() => 'linux'),
    getNodeMajorVersion: vi.fn(() => 25),
    getNodeVersion: vi.fn(() => '25.0.0'),
    hasSystemdUser: vi.fn(() => false),
  }));
  vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
    inspectRuntimeStorageReadiness: vi.fn(async () => ({
      status: 'pass',
      message: 'Postgres is ready.',
    })),
  }));
  vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
    createStorageRuntime: vi.fn(() => ({
      repositories: {
        modelCredentials: {
          // claude_code_oauth is live-verification skip-only, so the doctor's
          // live model check passes without a real network probe in this
          // isolated environment.
          listModelCredentials: vi.fn(async () => [
            {
              id: 'model-credential:default:anthropic',
              appId: 'default',
              providerId: 'anthropic',
              authMode: 'claude_code_oauth',
              schemaVersion: 1,
              fingerprint: 'test-fingerprint',
              fieldFingerprints: [],
              status: 'active',
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ]),
          getModelCredential: vi.fn(async () => ({
            id: 'model-credential:default:anthropic',
            appId: 'default',
            providerId: 'anthropic',
            authMode: 'claude_code_oauth',
            payload: {},
            schemaVersion: 1,
            fingerprint: 'test-fingerprint',
            fieldFingerprints: [],
            status: 'active',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          })),
        },
      },
      runtimeEventNotifier: { close: vi.fn(async () => {}) },
      service: { close: vi.fn(async () => {}) },
    })),
  }));
  vi.doMock('@core/cli/runtime-group-db.js', () => ({
    openRuntimeGroupDb: vi.fn(async () => ({
      countConversationRoutesByJidPrefix: vi.fn(async () => 1),
      close: vi.fn(async () => {}),
    })),
  }));
  vi.doMock('@core/config/preflight.js', async () => {
    const actual = await vi.importActual<any>('@core/config/preflight.js');
    return {
      ...actual,
      validateRuntimePreflightWithStorage: vi.fn(async () => ({
        ok: options?.preflightOk ?? true,
        failure: undefined,
      })),
    };
  });
  vi.doMock('@core/infrastructure/service/manager.js', () => ({
    getServiceStatus: vi.fn((runtimeHome: string) => {
      serviceCalls.push({ action: 'status', runtimeHome });
      return {
        kind: 'background',
        status: options?.serviceStatus ?? 'not_running',
      };
    }),
    installService: vi.fn((_importMetaUrl: string, runtimeHome: string) => {
      serviceCalls.push({ action: 'install', runtimeHome });
      return {
        ok: true,
        kind: 'background',
        message: `Installed isolated service metadata in ${runtimeHome}.`,
      };
    }),
    startService: vi.fn((runtimeHome: string) => {
      serviceCalls.push({ action: 'start', runtimeHome });
      return {
        ok: true,
        kind: 'background',
        message: `Started isolated service for ${runtimeHome}.`,
      };
    }),
    stopService: vi.fn((runtimeHome: string) => {
      serviceCalls.push({ action: 'stop', runtimeHome });
      return {
        ok: true,
        kind: 'background',
        message: `Stopped isolated service for ${runtimeHome}.`,
      };
    }),
  }));
  const { main } = await import('@core/cli/index.js');
  return { main, note, log, serviceCalls };
}

describe('runtime setup and doctor CLI e2e', () => {
  it('runs doctor against an isolated runtime home without using real credential files', async () => {
    const fixture = makeFixture();
    vi.stubEnv('HOME', `${fixture.runtimeHome}/fake-home`);
    vi.stubEnv('GANTRY_HOME', fixture.runtimeHome);

    const { main, note } = await loadCliWithBoundaryMocks();
    const code = await main(['--runtime-home', fixture.runtimeHome, 'doctor']);

    const rendered = note.mock.calls.map((call) => String(call[0])).join('\n');
    expect(code, rendered).toBe(0);
    expect(rendered).toContain('Postgres is ready.');
    expect(rendered).toContain('Gantry Model Gateway config is enabled');
    expect(rendered).not.toContain(process.env.HOME);
  });

  it('fails wrong-lane process credentials with a plain-English doctor message', async () => {
    const fixture = makeFixture();
    vi.stubEnv('GANTRY_HOME', fixture.runtimeHome);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ambient-anthropic');

    const { main, note } = await loadCliWithBoundaryMocks();
    const code = await main(['--runtime-home', fixture.runtimeHome, 'doctor']);

    expect(code).toBe(1);
    const rendered = note.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('process environment');
    expect(rendered).toContain(
      'Unset wrong-lane keys from your shell or service environment',
    );
  });

  it('routes service lifecycle commands only to the isolated runtime home', async () => {
    const fixture = makeFixture();
    const { main, serviceCalls } = await loadCliWithBoundaryMocks({
      serviceStatus: 'running(pid:12345)',
    });

    await expect(
      main(['--runtime-home', fixture.runtimeHome, 'service', 'install']),
    ).resolves.toBe(0);
    await expect(
      main(['--runtime-home', fixture.runtimeHome, 'service', 'start']),
    ).resolves.toBe(0);
    const statusCode = await main([
      '--runtime-home',
      fixture.runtimeHome,
      'status',
    ]);
    expect(statusCode, JSON.stringify(serviceCalls)).toBe(0);
    await expect(
      main(['--runtime-home', fixture.runtimeHome, 'service', 'stop']),
    ).resolves.toBe(0);

    expect(serviceCalls).toEqual(
      expect.arrayContaining([
        { action: 'install', runtimeHome: fixture.runtimeHome },
        { action: 'start', runtimeHome: fixture.runtimeHome },
        { action: 'status', runtimeHome: fixture.runtimeHome },
        { action: 'stop', runtimeHome: fixture.runtimeHome },
      ]),
    );
    expect(
      serviceCalls.every((call) =>
        call.runtimeHome.startsWith(fixture.runtimeHome),
      ),
    ).toBe(true);
  });
});

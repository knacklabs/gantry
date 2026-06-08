import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CapabilitySecretRepository,
  ModelCredentialRepository,
} from '@core/domain/ports/repositories.js';
import type { AppId } from '@core/domain/app/app.js';

const originalEnv = { ...process.env };

function makeSecretRepository() {
  const getSecret = vi.fn(async () => null);
  const upsertSecret = vi.fn(
    async (
      input: Parameters<CapabilitySecretRepository['upsertSecret']>[0],
    ) => ({
      id: `secret:${input.appId}:${input.name}` as never,
      appId: input.appId,
      name: input.name,
      allowedCapabilityIds: input.allowedCapabilityIds ?? [],
      createdAt: '2026-05-17T00:00:00.000Z',
      updatedAt: '2026-05-17T00:00:00.000Z',
    }),
  );
  const repository: CapabilitySecretRepository = {
    getSecret,
    listSecrets: vi.fn(async (input: { appId: AppId }) => [
      {
        id: 'secret:default:GITHUB_TOKEN' as never,
        appId: input.appId,
        name: 'GITHUB_TOKEN',
        allowedCapabilityIds: ['mcp:github'],
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
      },
    ]),
    upsertSecret,
    deleteSecret: vi.fn(async () => true),
  };
  return { repository, getSecret, upsertSecret };
}

function makeModelCredentialRepository() {
  const repository: ModelCredentialRepository = {
    getModelCredential: vi.fn(async () => null),
    listModelCredentials: vi.fn(async (input: { appId: AppId }) => [
      {
        id: 'model-credential:default:anthropic' as never,
        appId: input.appId,
        providerId: 'anthropic' as never,
        authMode: 'api_key',
        status: 'active',
        schemaVersion: 1,
        fingerprint: 'sha256:abcdef',
        fieldFingerprints: [
          {
            field: 'apiKey',
            fingerprint: 'sha256:field',
          },
        ],
        createdAt: '2026-05-17T00:00:00.000Z' as never,
        updatedAt: '2026-05-17T00:00:00.000Z' as never,
      },
    ]),
    upsertModelCredential: vi.fn(),
    disableModelCredential: vi.fn(),
  };
  return repository;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/adapters/storage/postgres/factory.js');
  vi.doUnmock('@core/cli/browser.js');
  process.env = { ...originalEnv };
});

describe('credentials capability CLI', () => {
  it('prints model credential status with friendly redacted labels', async () => {
    const { repository: capabilitySecrets } = makeSecretRepository();
    const modelCredentials = makeModelCredentialRepository();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      note,
      isCancel: vi.fn(() => false),
      password: vi.fn(),
      outro: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
      createStorageRuntime: () => ({
        service: {
          migrate: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        },
        runtimeEventNotifier: { close: vi.fn(async () => undefined) },
        runtimeEvents: { publish: vi.fn(async () => undefined) },
        repositories: { capabilitySecrets, modelCredentials },
      }),
    }));

    const { runCredentialsCommand } = await import('@core/cli/credentials.js');

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'model',
        'status',
      ]),
    ).resolves.toBe(0);

    const rendered = note.mock.calls.flat().join('\n');
    expect(rendered).toContain('auth mode: API key');
    expect(rendered).toContain('secret status: stored, encrypted, active');
    expect(rendered).toContain('runtime access: via Gantry Model Gateway');
    expect(rendered).toContain('configured: Anthropic key');
    expect(rendered).not.toContain('apiKey');
  });

  it('reports capability secrets that cannot be resolved as needing reset', async () => {
    const { repository } = makeSecretRepository();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      note,
      isCancel: vi.fn(() => false),
      password: vi.fn(),
      outro: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
      createStorageRuntime: () => ({
        service: {
          migrate: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        },
        runtimeEventNotifier: { close: vi.fn(async () => undefined) },
        runtimeEvents: { publish: vi.fn(async () => undefined) },
        repositories: {
          capabilitySecrets: repository,
          modelCredentials: makeModelCredentialRepository(),
        },
      }),
    }));

    const { runCredentialsCommand } = await import('@core/cli/credentials.js');

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'capability',
        'list',
      ]),
    ).resolves.toBe(0);

    const rendered = note.mock.calls.flat().join('\n');
    expect(rendered).toContain('GITHUB_TOKEN: needs reset');
    expect(rendered).not.toContain('secret-token-value');
  });

  it('imports shell secrets into Gantry Credentials without printing values', async () => {
    const { repository, upsertSecret } = makeSecretRepository();
    const success = vi.fn();
    const note = vi.fn();
    const publish = vi.fn(async () => undefined);
    vi.doMock('@clack/prompts', () => ({
      note,
      isCancel: vi.fn(() => false),
      password: vi.fn(),
      outro: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), success, warn: vi.fn() },
    }));
    vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
      createStorageRuntime: () => ({
        service: {
          migrate: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        },
        runtimeEventNotifier: { close: vi.fn(async () => undefined) },
        runtimeEvents: { publish },
        repositories: { capabilitySecrets: repository, modelCredentials: {} },
      }),
    }));
    process.env.GITHUB_TOKEN = 'secret-token-value';

    const { runCredentialsCommand } = await import('@core/cli/credentials.js');

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'capability',
        'import-env',
        'github_token',
        '--allow',
        'mcp:github',
      ]),
    ).resolves.toBe(0);

    expect(upsertSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        name: 'GITHUB_TOKEN',
        value: 'secret-token-value',
        actor: 'cli',
        allowedCapabilityIds: ['mcp:github'],
      }),
    );
    expect(success).toHaveBeenCalledWith('Imported GITHUB_TOKEN.');
    expect(note.mock.calls.flat().join('\n')).not.toContain(
      'secret-token-value',
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        actor: 'cli',
        eventType: 'credential.capability.updated',
        payload: expect.objectContaining({
          name: 'GITHUB_TOKEN',
          allowedCapabilityIds: ['mcp:github'],
        }),
      }),
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain(
      'secret-token-value',
    );
  });

  it('keeps browser credential namespace limited to status', async () => {
    const error = vi.fn();
    const runBrowserCommand = vi.fn(async () => 0);
    vi.doMock('@clack/prompts', () => ({
      note: vi.fn(),
      isCancel: vi.fn(() => false),
      password: vi.fn(),
      outro: vi.fn(),
      log: { error, info: vi.fn(), success: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('@core/cli/browser.js', () => ({ runBrowserCommand }));

    const { runCredentialsCommand } = await import('@core/cli/credentials.js');

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'browser',
        'profiles',
      ]),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      'Browser credentials only report profile/session status. Use `gantry credentials browser status`.',
    );
    expect(runBrowserCommand).not.toHaveBeenCalled();

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'browser',
        'status',
      ]),
    ).resolves.toBe(0);
    expect(runBrowserCommand).toHaveBeenCalledWith(
      '/tmp/gantry-credentials-test',
      ['status'],
    );
  });
});

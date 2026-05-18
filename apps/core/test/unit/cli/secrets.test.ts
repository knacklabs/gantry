import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapabilitySecretRepository } from '@core/domain/ports/repositories.js';
import type { AppId } from '@core/domain/app/app.js';

const originalEnv = { ...process.env };

function makeSecretRepository() {
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
    getSecret: vi.fn(async () => null),
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
  return { repository, upsertSecret };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/adapters/storage/postgres/factory.js');
  process.env = { ...originalEnv };
});

describe('secrets CLI', () => {
  it('imports shell secrets into Gantry Secrets without printing values', async () => {
    const { repository, upsertSecret } = makeSecretRepository();
    const success = vi.fn();
    const note = vi.fn();
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
        repositories: { capabilitySecrets: repository },
      }),
    }));
    process.env.GITHUB_TOKEN = 'secret-token-value';

    const { runSecretsCommand } = await import('@core/cli/secrets.js');

    await expect(
      runSecretsCommand('/tmp/gantry-secrets-test', [
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
  });
});

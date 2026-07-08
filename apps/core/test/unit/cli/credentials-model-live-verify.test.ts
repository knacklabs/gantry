import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelCredentialRepository } from '@core/domain/ports/repositories.js';
import type { AppId } from '@core/domain/app/app.js';

const verifyModelProviderCredentialLive = vi.hoisted(() => vi.fn());

vi.mock('@core/cli/model-credential-verify.js', () => ({
  verifyModelProviderCredentialLive,
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/adapters/storage/postgres/factory.js');
  verifyModelProviderCredentialLive.mockReset();
});

function mockCredentialCli(options: {
  password: string;
  existingPayload?: Record<string, string>;
}) {
  const success = vi.fn();
  const upsertModelCredential = vi.fn(
    async (
      input: Parameters<ModelCredentialRepository['upsertModelCredential']>[0],
    ) => ({
      id: `model-credential:${input.appId}:${input.providerId}` as never,
      appId: input.appId,
      providerId: input.providerId,
      authMode: input.authMode,
      status: 'active' as const,
      schemaVersion: input.schemaVersion,
      fingerprint: input.fingerprint,
      fieldFingerprints: input.fieldFingerprints,
      createdAt: '2026-05-17T00:00:00.000Z' as never,
      updatedAt: '2026-05-17T00:00:00.000Z' as never,
    }),
  );
  const getModelCredential = vi.fn(
    async (input: { appId: AppId; providerId: string }) =>
      options.existingPayload
        ? {
            id: `model-credential:${input.appId}:${input.providerId}` as never,
            appId: input.appId,
            providerId: input.providerId as never,
            authMode: 'api_key',
            status: 'active' as const,
            schemaVersion: 1,
            payload: options.existingPayload,
            fingerprint: 'sha256:existing',
            fieldFingerprints: [],
            createdAt: '2026-05-17T00:00:00.000Z' as never,
            updatedAt: '2026-05-17T00:00:00.000Z' as never,
          }
        : null,
  );
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    password: vi.fn(async () => options.password),
    text: vi.fn(async () => options.password),
    select: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    log: { error: vi.fn(), info: vi.fn(), success, warn: vi.fn() },
  }));
  vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
    createStorageRuntime: () => ({
      service: {
        assertMigrationsCurrent: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      runtimeEventNotifier: { close: vi.fn(async () => undefined) },
      runtimeEvents: { publish: vi.fn(async () => undefined) },
      repositories: {
        capabilitySecrets: {},
        modelCredentials: {
          getModelCredential,
          listModelCredentials: vi.fn(async () => []),
          upsertModelCredential,
          disableModelCredential: vi.fn(),
        },
      },
    }),
  }));
  verifyModelProviderCredentialLive.mockResolvedValue({ ok: true });
  return { getModelCredential, success, upsertModelCredential };
}

describe('credentials model live verification', () => {
  it('verifies a set payload before storing it', async () => {
    const { upsertModelCredential } = mockCredentialCli({
      password: 'new-key',
    });
    const { runCredentialsCommand } = await import('@core/cli/credentials.js');

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'model',
        'set',
        'openai',
      ]),
    ).resolves.toBe(0);

    expect(verifyModelProviderCredentialLive).toHaveBeenCalledWith({
      providerId: 'openai',
      authMode: 'api_key',
      payload: { apiKey: 'new-key' },
    });
    expect(
      verifyModelProviderCredentialLive.mock.invocationCallOrder[0],
    ).toBeLessThan(upsertModelCredential.mock.invocationCallOrder[0]!);
  });

  it('verifies the merged rotate payload before rotating', async () => {
    const { upsertModelCredential } = mockCredentialCli({
      password: 'new-key',
      existingPayload: { apiKey: 'old-key' },
    });
    const { runCredentialsCommand } = await import('@core/cli/credentials.js');

    await expect(
      runCredentialsCommand('/tmp/gantry-credentials-test', [
        'model',
        'rotate',
        'anthropic',
      ]),
    ).resolves.toBe(0);

    expect(verifyModelProviderCredentialLive).toHaveBeenCalledWith({
      providerId: 'anthropic',
      authMode: 'api_key',
      payload: { apiKey: 'new-key' },
    });
    expect(upsertModelCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        payload: { apiKey: 'new-key' },
      }),
    );
  });
});

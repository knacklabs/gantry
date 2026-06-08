import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/adapters/storage/postgres/factory.js');
});

async function loadCredentialsStep(
  input: {
    selections?: string[];
    password?: string;
  } = {},
) {
  const note = vi.fn();
  const success = vi.fn();
  const password = vi.fn(async () => input.password ?? 'provider-key');
  const selections = [...(input.selections ?? ['anthropic', 'defer'])];
  const select = vi.fn(async () => selections.shift() ?? 'defer');
  const upsertModelCredential = vi.fn(async (credentialInput) => ({
    id: 'model-credential:default:anthropic',
    appId: credentialInput.appId,
    providerId: credentialInput.providerId,
    authMode: credentialInput.authMode,
    status: 'active',
    schemaVersion: credentialInput.schemaVersion,
    fingerprint: credentialInput.fingerprint,
    fieldFingerprints: credentialInput.fieldFingerprints,
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
  }));
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note,
    password,
    select,
    log: { error: vi.fn(), info: vi.fn(), success, warn: vi.fn() },
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
        capabilitySecrets: {},
        modelCredentials: {
          upsertModelCredential,
        },
      },
    }),
  }));
  const { runCredentialsStep, verifyModelAccess } =
    await import('@core/cli/setup-credentials.js');
  return {
    runCredentialsStep,
    verifyModelAccess,
    note,
    password,
    select,
    success,
    upsertModelCredential,
  };
}

describe('setup credentials step', () => {
  it('stores model credentials inline by default when selected', async () => {
    const {
      runCredentialsStep,
      password,
      select,
      success,
      upsertModelCredential,
    } = await loadCredentialsStep({
      selections: ['anthropic', 'api_key', 'store'],
    });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'next' });
    expect(draft.credentialMode).toBe('gantry');
    expect(password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Anthropic key' }),
    );
    expect(upsertModelCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        providerId: 'anthropic',
        authMode: 'api_key',
        payload: { apiKey: 'provider-key' },
        actor: 'cli',
      }),
    );
    expect(success).toHaveBeenCalledWith(
      'Anthropic credential stored. Model Access is ready to validate during runtime preflight.',
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.not.arrayContaining([
          expect.objectContaining({ value: 'openai' }),
        ]),
      }),
    );
  });

  it('keeps an explicit deferred credential command path', async () => {
    const { runCredentialsStep, note, password, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['anthropic', 'api_key', 'defer'],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'next' });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('gantry credentials model set anthropic'),
      'Model Access',
    );
    expect(note.mock.calls.flat().join('\n')).not.toContain('api_key');
    expect(password).not.toHaveBeenCalled();
    expect(upsertModelCredential).not.toHaveBeenCalled();
  });

  it('defers model credential validation to model preflight', async () => {
    const { verifyModelAccess } = await loadCredentialsStep();

    await expect(verifyModelAccess()).resolves.toEqual({
      ok: true,
      message:
        'Gantry Model Gateway credentials are stored in Postgres and validated during model preflight.',
    });
  });
});

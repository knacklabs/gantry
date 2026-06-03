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
  const selections = [...(input.selections ?? ['anthropic', 'store'])];
  const select = vi.fn(async () => selections.shift() ?? 'store');
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

  it('lets the user go back instead of deferring required credentials', async () => {
    const { runCredentialsStep, password, select, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['anthropic', 'api_key', 'back'],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'back' });
    const storePrompt = select.mock.calls.find(
      (call) => call[0].message === 'Store this model credential now?',
    )?.[0];
    expect(storePrompt?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'store' }),
        expect.objectContaining({ value: 'back' }),
        expect.objectContaining({ value: 'resume' }),
        expect.objectContaining({ value: 'cancel' }),
      ]),
    );
    expect(storePrompt?.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'defer' })]),
    );
    expect(password).not.toHaveBeenCalled();
    expect(upsertModelCredential).not.toHaveBeenCalled();
  });

  it('can go back from the first model access prompt', async () => {
    const { runCredentialsStep, password, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['back'],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'back' });
    expect(password).not.toHaveBeenCalled();
    expect(upsertModelCredential).not.toHaveBeenCalled();
  });

  it('reports missing model credentials during setup verification', async () => {
    vi.doMock('@core/cli/model-credential-readiness.js', () => ({
      inspectModelCredentialReadiness: vi.fn(async () => ({
        id: 'model-access-credentials',
        title: 'Model Access Credentials',
        status: 'fail',
        message:
          'Missing active model credentials for selected defaults: anthropic.',
        nextAction: 'Run `gantry credentials model set anthropic`.',
      })),
    }));
    const { verifyModelAccess } =
      await import('@core/cli/setup-credentials.js');

    await expect(
      verifyModelAccess('/tmp/gantry-credentials-test', {} as never),
    ).resolves.toEqual({
      ok: false,
      message:
        'Missing active model credentials for selected defaults: anthropic.',
      nextAction: 'Run `gantry credentials model set anthropic`.',
    });
  });
});

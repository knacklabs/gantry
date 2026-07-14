import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/adapters/storage/postgres/factory.js');
  vi.doUnmock('@core/cli/model-credential-verify.js');
});

async function loadCredentialsStep(
  input: {
    selections?: string[];
    password?: string;
    readyProviders?: string[];
    verificationResults?: Array<
      | { ok: true }
      | { ok: false; message: string }
      | { skipped: true; reason: string }
    >;
  } = {},
) {
  const note = vi.fn();
  const success = vi.fn();
  const warn = vi.fn();
  const password = vi.fn(async () => input.password ?? 'provider-key');
  const selections = [...(input.selections ?? ['api_key', 'store'])];
  const select = vi.fn(async () => selections.shift() ?? 'store');
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const verificationResults = [
    ...(input.verificationResults ?? [{ ok: true as const }]),
  ];
  const verifyModelProviderCredentialLive = vi.fn(
    async () => verificationResults.shift() ?? { ok: true },
  );
  const listModelCredentials = vi.fn(async () =>
    (input.readyProviders ?? []).map((providerId) => ({
      id: `model-credential:default:${providerId}`,
      appId: 'default',
      providerId,
      authMode: 'api_key',
      status: 'active',
      schemaVersion: 1,
      fingerprint: 'fp',
      fieldFingerprints: [],
      createdAt: '2026-05-17T00:00:00.000Z',
      updatedAt: '2026-05-17T00:00:00.000Z',
    })),
  );
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
    spinner: () => spinner,
    log: { error: vi.fn(), info: vi.fn(), success, warn },
  }));
  vi.doMock('@core/cli/model-credential-verify.js', () => ({
    verifyModelProviderCredentialLive,
  }));
  vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
    createStorageRuntime: () => ({
      service: {
        migrate: vi.fn(async () => undefined),
        assertMigrationsCurrent: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      runtimeEventNotifier: { close: vi.fn(async () => undefined) },
      runtimeEvents: { publish: vi.fn(async () => undefined) },
      repositories: {
        capabilitySecrets: {},
        modelCredentials: {
          listModelCredentials,
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
    warn,
    verifyModelProviderCredentialLive,
    listModelCredentials,
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
      selections: ['api_key', 'store'],
    });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'opus',
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
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
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Model access provider' }),
    );
  });

  it('prompts only missing providers required by selected defaults', async () => {
    const { runCredentialsStep, note, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['store'],
        readyProviders: ['anthropic'],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'gpt',
      memoryEnabled: true,
      embeddingsEnabled: true,
      dreamingEnabled: true,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'next' });
    expect(note).toHaveBeenCalledWith(
      'Selected defaults require credentials for: openai.',
      'Model Access required',
    );
    expect(upsertModelCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
      }),
    );
  });

  it('explains OpenAI separately when only embeddings require it', async () => {
    const { requiredModelCredentialProviderReasonsForSetupDraft } =
      await import('@core/cli/setup-credentials.js');

    expect(
      requiredModelCredentialProviderReasonsForSetupDraft({
        credentialMode: 'gantry',
        selectedModel: 'opus',
        memoryEnabled: true,
        embeddingsEnabled: true,
        dreamingEnabled: true,
      }),
    ).toEqual([
      expect.objectContaining({
        providerId: 'anthropic',
        reasons: expect.arrayContaining([
          'main model opus',
          'memory LLM extractor haiku',
        ]),
      }),
      {
        providerId: 'openai',
        reasons: ['memory embeddings'],
      },
    ]);
  });

  it('lets the user go back instead of deferring required credentials', async () => {
    const { runCredentialsStep, password, select, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['api_key', 'back'],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'opus',
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
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

  it('re-prompts when live verification fails and the user re-enters the key', async () => {
    const {
      runCredentialsStep,
      password,
      verifyModelProviderCredentialLive,
      upsertModelCredential,
    } = await loadCredentialsStep({
      selections: ['api_key', 'store', 'reenter'],
      verificationResults: [
        { ok: false, message: 'Anthropic rejected key.' },
        { ok: true },
      ],
    });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'opus',
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'next' });
    expect(password).toHaveBeenCalledTimes(2);
    expect(verifyModelProviderCredentialLive).toHaveBeenCalledTimes(2);
    expect(upsertModelCredential).toHaveBeenCalledTimes(1);
  });

  it('stores when live verification fails and the user explicitly skips', async () => {
    const { runCredentialsStep, warn, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['api_key', 'store', 'store_anyway'],
        verificationResults: [
          { ok: false, message: 'Anthropic rejected key.' },
        ],
      });
    const draft = {
      runtimeHome: '/tmp/gantry-credentials-test',
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'opus',
      credentialLiveSkipProviderIds: [] as string[],
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'next' });
    expect(upsertModelCredential).toHaveBeenCalledTimes(1);
    expect(draft.credentialLiveSkipProviderIds).toEqual(['anthropic']);
    const { createInitialState } =
      await import('@core/cli/onboarding-state.js');
    const { updateStateData } = await import('@core/cli/setup-flow-state.js');
    const state = createInitialState('/tmp/gantry-credentials-test');
    updateStateData(state, draft as never);
    expect(state.data.credentialLiveSkipProviderIds).toEqual(['anthropic']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stored without live verification'),
    );
  });

  it('can go back from the first model access prompt', async () => {
    const { runCredentialsStep, password, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['back'],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'opus',
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual({ type: 'back' });
    expect(password).not.toHaveBeenCalled();
    expect(upsertModelCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', { type: 'resume' }],
    ['cancel', { type: 'cancel' }],
  ])(
    'can %s from the first model access prompt',
    async (selection, expected) => {
      const { runCredentialsStep, password, upsertModelCredential } =
        await loadCredentialsStep({
          selections: [selection],
        });
      const draft = {
        credentialMode: 'none' as const,
        postgresSetupKind: 'local' as const,
        selectedModel: 'opus',
        memoryEnabled: false,
        embeddingsEnabled: false,
        dreamingEnabled: false,
      };

      const action = await runCredentialsStep(
        draft,
        '/tmp/gantry-credentials-test',
      );

      expect(action).toEqual(expected);
      expect(password).not.toHaveBeenCalled();
      expect(upsertModelCredential).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['resume', { type: 'resume' }],
    ['cancel', { type: 'cancel' }],
  ])('can %s from the credential store prompt', async (selection, expected) => {
    const { runCredentialsStep, password, upsertModelCredential } =
      await loadCredentialsStep({
        selections: ['api_key', selection],
      });
    const draft = {
      credentialMode: 'none' as const,
      postgresSetupKind: 'local' as const,
      selectedModel: 'opus',
      memoryEnabled: false,
      embeddingsEnabled: false,
      dreamingEnabled: false,
    };

    const action = await runCredentialsStep(
      draft,
      '/tmp/gantry-credentials-test',
    );

    expect(action).toEqual(expected);
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

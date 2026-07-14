import { afterEach, describe, expect, it, vi } from 'vitest';

const googleAuthMocks = vi.hoisted(() => {
  const getAccessToken = vi.fn(async () => ({ token: 'ya29.vertex-token' }));
  const getClient = vi.fn(async () => ({ getAccessToken }));
  const constructor = vi.fn();
  return { constructor, getAccessToken, getClient };
});

const awsCredentialMocks = vi.hoisted(() => {
  const provider = vi.fn(async () => ({
    accessKeyId: 'AKIDDEFAULT',
    secretAccessKey: 'default-secret-access-key',
  }));
  const defaultProvider = vi.fn(() => provider);
  return { defaultProvider, provider };
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function GoogleAuthMock(options) {
    googleAuthMocks.constructor(options);
    return { getClient: googleAuthMocks.getClient };
  }),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: awsCredentialMocks.defaultProvider,
}));

import { verifyModelProviderCredentialLive } from '@core/cli/model-credential-verify.js';
import { clearVertexTokenCacheForTest } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-auth-vertex.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearVertexTokenCacheForTest();
  googleAuthMocks.constructor.mockClear();
  googleAuthMocks.getClient.mockReset();
  googleAuthMocks.getClient.mockResolvedValue({
    getAccessToken: googleAuthMocks.getAccessToken,
  });
  googleAuthMocks.getAccessToken.mockReset();
  googleAuthMocks.getAccessToken.mockResolvedValue({
    token: 'ya29.vertex-token',
  });
  awsCredentialMocks.defaultProvider.mockReset();
  awsCredentialMocks.defaultProvider.mockImplementation(
    () => awsCredentialMocks.provider,
  );
  awsCredentialMocks.provider.mockReset();
  awsCredentialMocks.provider.mockResolvedValue({
    accessKeyId: 'AKIDDEFAULT',
    secretAccessKey: 'default-secret-access-key',
  });
});

describe('model credential live verification', () => {
  it('passes when an OpenAI-compatible provider accepts the key', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      verifyModelProviderCredentialLive({
        providerId: 'groq',
        authMode: 'api_key',
        payload: { apiKey: 'gsk-test' },
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyModelProviderCredentialLive({
        providerId: 'perplexity',
        authMode: 'api_key',
        payload: { apiKey: 'pplx-test' },
      }),
    ).resolves.toEqual({ ok: true });
    // Perplexity's chat prefix is empty but its model list lives under /v1.
    expect(fetchSpy).toHaveBeenLastCalledWith(
      new URL('https://api.perplexity.ai/v1/models'),
      expect.anything(),
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('https://api.groq.com/openai/v1/models'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer gsk-test',
        }),
      }),
    );
  });

  it('returns the upstream body snippet on 401 or 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'bad key' }), { status: 401 }),
      ),
    );

    const result = await verifyModelProviderCredentialLive({
      providerId: 'openrouter',
      authMode: 'api_key',
      payload: { apiKey: 'sk-or-test' },
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('HTTP 401'),
    });
    expect('ok' in result && result.message).toContain('bad key');
  });

  it('redacts secret-shaped tokens echoed by the upstream error body', async () => {
    const echoedKey = 'sk-or-v1-abcdef0123456789abcdef0123456789';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: `invalid key ${echoedKey}`,
              authorization: 'Bearer gtw_someverylongtokenvalue123456',
            }),
            { status: 401 },
          ),
      ),
    );

    const result = await verifyModelProviderCredentialLive({
      providerId: 'openrouter',
      authMode: 'api_key',
      payload: { apiKey: echoedKey },
    });

    const message = 'ok' in result && !result.ok ? result.message : '';
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(echoedKey);
    expect(message).not.toContain('someverylongtokenvalue');
  });

  it('reports timeout and network failures as could-not-reach-provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }),
    );

    const result = await verifyModelProviderCredentialLive({
      providerId: 'openai',
      authMode: 'api_key',
      payload: { apiKey: 'sk-test' },
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('could not reach provider'),
    });
  });

  it('verifies Vertex service-account credentials by fetching an access token', async () => {
    const { verifyModelProviderCredentialLive } =
      await import('@core/cli/model-credential-verify.js');
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      project_id: 'project-12345',
      client_email: 'svc@example.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
    });

    await expect(
      verifyModelProviderCredentialLive({
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: 'global',
          projectId: 'project-12345',
          serviceAccountJson,
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(googleAuthMocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          client_email: 'svc@example.com',
        }),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    );
  });

  it('rejects a service-account JSON carrying a rogue token_uri', async () => {
    const result = await verifyModelProviderCredentialLive({
      providerId: 'vertex',
      authMode: 'service_account',
      payload: {
        region: 'global',
        projectId: 'project-12345',
        serviceAccountJson: JSON.stringify({
          type: 'service_account',
          project_id: 'project-12345',
          client_email: 'svc@example.com',
          private_key:
            '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
          token_uri: 'https://attacker.example.com/token',
        }),
      },
    });

    expect(result).toMatchObject({ ok: false });
    // The hardened runtime parser rejects it before any token request fires.
    expect(googleAuthMocks.getAccessToken).not.toHaveBeenCalled();
  });

  it('returns a redacted Vertex service-account auth failure', async () => {
    const { verifyModelProviderCredentialLive } =
      await import('@core/cli/model-credential-verify.js');
    const echoedSecret = 'sk-google-abcdef0123456789abcdef0123456789';
    googleAuthMocks.getAccessToken.mockRejectedValueOnce(
      new Error(`invalid_grant for ${echoedSecret}`),
    );

    const result = await verifyModelProviderCredentialLive({
      providerId: 'vertex',
      authMode: 'service_account',
      payload: {
        region: 'global',
        projectId: 'project-12345',
        serviceAccountJson: JSON.stringify({
          type: 'service_account',
          project_id: 'project-12345',
          client_email: 'svc@example.com',
          private_key:
            '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
        }),
      },
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('credential verification failed'),
    });
    expect('ok' in result && result.message).toContain('[redacted]');
    expect('ok' in result && result.message).not.toContain(echoedSecret);
  });

  it('gives an actionable message when Vertex ADC is missing', async () => {
    const { verifyModelProviderCredentialLive } =
      await import('@core/cli/model-credential-verify.js');
    googleAuthMocks.getAccessToken.mockRejectedValueOnce(
      new Error('Could not load the default credentials.'),
    );

    await expect(
      verifyModelProviderCredentialLive({
        providerId: 'vertex',
        authMode: 'google_adc',
        payload: { region: 'global', projectId: 'project-12345' },
      }),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('gcloud auth application-default login'),
    });
  });

  it('resolves the Bedrock default credential chain without over-verifying Bedrock', async () => {
    const { verifyModelProviderCredentialLive } =
      await import('@core/cli/model-credential-verify.js');

    await expect(
      verifyModelProviderCredentialLive({
        providerId: 'bedrock',
        authMode: 'aws_default_chain',
        payload: { region: 'us-east-1', profile: 'dev' },
      }),
    ).resolves.toEqual({
      skipped: true,
      reason: 'AWS credentials resolved locally; not verified against Bedrock.',
    });
    expect(awsCredentialMocks.defaultProvider).toHaveBeenCalledWith({
      profile: 'dev',
    });
  });

  it('fails when the Bedrock default credential chain cannot resolve credentials', async () => {
    const { verifyModelProviderCredentialLive } =
      await import('@core/cli/model-credential-verify.js');
    awsCredentialMocks.provider.mockRejectedValueOnce(
      new Error('ProviderError: no credentials'),
    );

    await expect(
      verifyModelProviderCredentialLive({
        providerId: 'bedrock',
        authMode: 'aws_default_chain',
        payload: { region: 'us-east-1' },
      }),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringContaining(
        'No AWS credentials resolved from the default chain',
      ),
    });
  });

  it.each([
    ['anthropic', 'claude_code_oauth', { oauthToken: 'token' }],
    ['bedrock', 'bedrock_api_key', { region: 'us-east-1', apiKey: 'key' }],
  ])('skips %s %s live checks in v1', async (providerId, authMode, payload) => {
    const { verifyModelProviderCredentialLive } =
      await import('@core/cli/model-credential-verify.js');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyModelProviderCredentialLive({
      providerId,
      authMode,
      payload,
    });

    expect(result).toEqual({
      skipped: true,
      reason: expect.any(String),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

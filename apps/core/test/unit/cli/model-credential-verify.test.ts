import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyModelProviderCredentialLive } from '@core/cli/model-credential-verify.js';

afterEach(() => {
  vi.unstubAllGlobals();
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

  it.each([
    ['anthropic', 'claude_code_oauth', { oauthToken: 'token' }],
    ['bedrock', 'bedrock_api_key', { region: 'us-east-1', apiKey: 'key' }],
    [
      'vertex',
      'service_account',
      {
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
    ],
  ])('skips %s %s live checks in v1', async (providerId, authMode, payload) => {
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';

import { GantryModelGatewayBroker } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway.js';
import { signAwsSigV4Request } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-auth-sigv4.js';
import {
  clearVertexTokenCacheForTest,
  getVertexServiceAccountBearerToken,
} from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-auth-vertex.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  ModelCredential,
  ModelCredentialMetadata,
  ModelCredentialProvider,
} from '@core/domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '@core/domain/ports/repositories.js';
import {
  getModelProviderDefinition,
  type ModelCredentialModeDefinition,
} from '@core/shared/model-provider-registry.js';

const vertexGetAccessTokenMock = vi.hoisted(() =>
  vi.fn(async () => ({ token: 'ya29.vertex-token' })),
);
const googleAuthOptionsMock = vi.hoisted(() => vi.fn());

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function GoogleAuthMock(options) {
    googleAuthOptionsMock(options);
    return {
      getClient: async () => ({
        getAccessToken: vertexGetAccessTokenMock,
        credentials: { expiry_date: Date.now() + 3_600_000 },
      }),
    };
  }),
}));

const appId = 'default' as AppId;
const anthropicBaseUrlKey = ['ANTHROPIC', 'BASE_URL'].join('_');
const anthropicApiKeyKey = ['ANTHROPIC', 'API_KEY'].join('_');
const claudeCodeOAuthTokenKey = ['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_');

class MutableModelCredentialRepository implements ModelCredentialRepository {
  private readonly rows = new Map<string, ModelCredential>();

  set(providerId: ModelCredentialProvider, value: string): void {
    this.setWithMode(providerId, 'api_key', { apiKey: value });
  }

  setWithMode(
    providerId: ModelCredentialProvider,
    authMode: string,
    payload: Record<string, string>,
  ): void {
    const now = new Date().toISOString();
    const fingerprint = `fp:${providerId}:${createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')
      .slice(0, 8)}`;
    this.rows.set(`${appId}:${providerId}`, {
      id: `model-credential:${providerId}` as never,
      appId,
      providerId,
      authMode,
      status: 'active',
      schemaVersion: 1,
      payload,
      fingerprint,
      fieldFingerprints: Object.keys(payload).map((field) => ({
        field,
        fingerprint,
      })),
      createdAt: now,
      updatedAt: now,
    });
  }

  disable(providerId: ModelCredentialProvider): void {
    const key = `${appId}:${providerId}`;
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.set(key, {
      ...row,
      status: 'disabled',
      updatedAt: new Date().toISOString(),
    });
  }

  async getModelCredential(input: {
    appId: ModelCredential['appId'];
    providerId: ModelCredentialProvider;
  }): Promise<ModelCredential | null> {
    return this.rows.get(`${input.appId}:${input.providerId}`) ?? null;
  }

  async listModelCredentials(input: {
    appId: ModelCredentialMetadata['appId'];
  }): Promise<ModelCredentialMetadata[]> {
    return [...this.rows.values()]
      .filter((row) => row.appId === input.appId)
      .map(({ payload: _payload, ...metadata }) => metadata);
  }

  async upsertModelCredential(): Promise<ModelCredentialMetadata> {
    throw new Error('not needed');
  }

  async disableModelCredential(): Promise<ModelCredentialMetadata | null> {
    throw new Error('not needed');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vertexGetAccessTokenMock.mockClear();
  googleAuthOptionsMock.mockClear();
  clearVertexTokenCacheForTest();
});

function gatewayRequest(input: {
  url: string;
  token: string;
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
}): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      input.url,
      {
        method: input.method ?? 'POST',
        headers: {
          'x-api-key': input.token,
          'content-type': 'application/json',
          ...input.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(input.method === 'GET' ? undefined : (input.body ?? '{}'));
  });
}

function gatewayStreamingRequest(input: { url: string; token: string }): {
  firstChunk: Promise<string>;
  done: Promise<{ status: number; body: string }>;
} {
  let resolveFirstChunk!: (value: string) => void;
  let rejectFirstChunk!: (error: unknown) => void;
  let sawFirstChunk = false;
  const firstChunk = new Promise<string>((resolve, reject) => {
    resolveFirstChunk = resolve;
    rejectFirstChunk = reject;
  });
  const done = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        input.url,
        {
          method: 'POST',
          headers: {
            'x-api-key': input.token,
            'content-type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            const buffer = Buffer.from(chunk);
            chunks.push(buffer);
            if (!sawFirstChunk) {
              sawFirstChunk = true;
              resolveFirstChunk(buffer.toString('utf-8'));
            }
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            }),
          );
        },
      );
      req.on('error', (error) => {
        rejectFirstChunk(error);
        reject(error);
      });
      req.end('{}');
    },
  );
  return { firstChunk, done };
}

function gatewayRawPathRequest(input: {
  baseUrl: string;
  path: string;
  token: string;
}): Promise<{ status: number; body: string }> {
  const base = new URL(input.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `${base.pathname}${input.path}`,
        method: 'POST',
        headers: {
          'x-api-key': input.token,
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

function vertexServiceAccountJson(projectId: string): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    client_email: `${projectId}@example.iam.gserviceaccount.com`,
    private_key:
      '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
  });
}

describe('GantryModelGatewayBroker', () => {
  it('produces a stable Bedrock SigV4 known-answer signature', () => {
    const headers: Record<string, string> = {
      'content-type': ' application/json  ',
      'x-amz-meta-z': ' last ',
      'x-amz-meta-a': ' first   value ',
    };

    signAwsSigV4Request({
      method: 'POST',
      url: new URL(
        'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions?b=two&a=one&a=zero&space=a%20b',
      ),
      headers,
      body: Buffer.from('{"model":"openai.gpt-oss-120b-1:0"}'),
      region: 'us-east-1',
      service: 'bedrock',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        sessionToken: 'session-token',
      },
      now: new Date('2026-06-14T12:34:56.000Z'),
    });

    expect(headers['x-amz-date']).toBe('20260614T123456Z');
    expect(headers['x-amz-content-sha256']).toBe(
      'e6f5b76929970d12f510677a95e505022a28268c8cfcc023e92171adbc006101',
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260614/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-a;x-amz-meta-z;x-amz-security-token, Signature=9de8178ec3b808de2eb860072e16d957ba0bee0c621ba1242b9c387b9e372076',
    );
  });

  it('signs literal plus signs in Bedrock SigV4 query strings as plus signs', () => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    signAwsSigV4Request({
      method: 'POST',
      url: new URL(
        'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions?x=a+b&plus=%2B',
      ),
      headers,
      body: Buffer.from('{"model":"openai.gpt-oss-120b-1:0"}'),
      region: 'us-east-1',
      service: 'bedrock',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2026-06-14T12:34:56.000Z'),
    });

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260614/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=ff3f5da667eb17cba3654b18053a2619b7c06f8473792b88fa907875beac0f74',
    );
  });

  it('mints and caches Vertex service-account bearer tokens host-side', async () => {
    const serviceAccountJson = vertexServiceAccountJson('other-project');

    const firstToken = await getVertexServiceAccountBearerToken({
      serviceAccountJson,
      expectedProjectId: 'gantry-test',
      nowMs: 1_000,
    });
    const secondToken = await getVertexServiceAccountBearerToken({
      serviceAccountJson,
      expectedProjectId: 'gantry-test',
      nowMs: 2_000,
    });

    expect(firstToken).toBe('ya29.vertex-token');
    expect(secondToken).toBe('ya29.vertex-token');
    expect(vertexGetAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(googleAuthOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        credentials: expect.objectContaining({
          project_id: 'other-project',
          client_email: 'other-project@example.iam.gserviceaccount.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
      }),
    );
  });

  it('rejects a malicious Vertex service-account token URI before GoogleAuth', async () => {
    await expect(
      getVertexServiceAccountBearerToken({
        serviceAccountJson: JSON.stringify({
          type: 'service_account',
          project_id: 'other-project',
          client_email: 'other-project@example.iam.gserviceaccount.com',
          private_key:
            '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
          token_uri: 'https://evil.example/token',
        }),
        expectedProjectId: 'gantry-test',
        nowMs: 1_000,
      }),
    ).rejects.toThrow('Invalid Vertex service account credential.');
    expect(googleAuthOptionsMock).not.toHaveBeenCalled();
    expect(vertexGetAccessTokenMock).not.toHaveBeenCalled();
  });

  it('times out a stuck Vertex service-account access-token request', async () => {
    vi.useFakeTimers();
    vertexGetAccessTokenMock.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    try {
      const tokenPromise = getVertexServiceAccountBearerToken({
        serviceAccountJson: vertexServiceAccountJson('gantry-test'),
        expectedProjectId: 'gantry-test',
        nowMs: 1_000,
        tokenRequestTimeoutMs: 5,
      });
      const rejection = expect(tokenPromise).rejects.toThrow(
        'Vertex service account token request timed out.',
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(vertexGetAccessTokenMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the Vertex service-account token cache', async () => {
    for (let index = 0; index < 129; index += 1) {
      const projectId = `gantry-test-${index}`;
      await getVertexServiceAccountBearerToken({
        serviceAccountJson: vertexServiceAccountJson(projectId),
        expectedProjectId: projectId,
        nowMs: 1_000,
      });
    }

    await getVertexServiceAccountBearerToken({
      serviceAccountJson: vertexServiceAccountJson('gantry-test-0'),
      expectedProjectId: 'gantry-test-0',
      nowMs: 2_000,
    });

    expect(vertexGetAccessTokenMock).toHaveBeenCalledTimes(130);
  });

  it('projects only a loopback URL and run-scoped token', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      expect(injection).toMatchObject({
        applied: true,
        brokerProfile: 'gantry',
        credentialProviders: { [anthropicApiKeyKey]: 'native' },
      });
      expect(injection.env[anthropicBaseUrlKey]).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/,
      );
      expect(injection.env[anthropicApiKeyKey]).toMatch(/^gtw_/);
      expect(injection.env[anthropicApiKeyKey]).not.toContain('sk-ant');
    } finally {
      await broker.close();
    }
  });

  it('passes ToolSearch deferred tools and tool references through the Anthropic gateway', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'tool_search_tool_result',
                content: {
                  type: 'tool_search_tool_search_result',
                  tool_references: [
                    {
                      type: 'tool_reference',
                      tool_name: 'search_slack_messages',
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      const body = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'search slack' }],
        tools: [
          {
            name: 'search_slack_messages',
            description: 'Search Slack messages by keyword and channel.',
            input_schema: { type: 'object', properties: {} },
            defer_loading: true,
          },
          {
            type: 'tool_search_tool_bm25_20251119',
            name: 'tool_search_tool_bm25',
          },
        ],
      });

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
        headers: { 'anthropic-beta': 'tool-search-2025-11-19' },
        body,
      });

      expect(response.status).toBe(200);
      const upstreamOptions = upstreamFetch.mock.calls[0]?.[1];
      const upstreamBody = JSON.parse(
        Buffer.from(upstreamOptions?.body as Buffer).toString('utf-8'),
      );
      expect(upstreamBody.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'search_slack_messages',
            defer_loading: true,
          }),
          expect.objectContaining({
            type: 'tool_search_tool_bm25_20251119',
          }),
        ]),
      );
      expect(upstreamOptions?.headers).toEqual(
        expect.objectContaining({
          'anthropic-beta': 'tool-search-2025-11-19',
          'x-api-key': 'sk-ant-upstream',
        }),
      );
      expect(response.body).toContain('"tool_reference"');
      expect(response.body).toContain('"search_slack_messages"');
    } finally {
      await broker.close();
    }
  });

  it('projects Anthropic Claude Code OAuth through gateway credentials', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('anthropic', 'claude_code_oauth', {
      oauthToken: 'sk-ant-oat-upstream',
    });
    const upstreamFetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      expect(injection).toMatchObject({
        applied: true,
        brokerProfile: 'gantry',
        credentialProviders: { [anthropicApiKeyKey]: 'native' },
      });
      expect(injection.env[anthropicBaseUrlKey]).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/,
      );
      expect(injection.env[anthropicApiKeyKey]).toMatch(/^gtw_/);
      expect(injection.env[anthropicApiKeyKey]).not.toContain('sk-ant-oat');
      expect(injection.env[claudeCodeOAuthTokenKey]).toBeUndefined();

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://api.anthropic.com/v1/messages'),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer sk-ant-oat-upstream',
          }),
        }),
      );
      expect(upstreamFetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            'x-api-key': 'sk-ant-oat-upstream',
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it('A9: rejects a forged run token on the OAuth lane without reaching the Bearer upstream', async () => {
    // Behavioral backstop for the claude_code_oauth lane: the gateway must
    // authenticate the run-scoped token before swapping in the upstream Bearer
    // credential. A forged token is rejected and never reaches upstream.
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('anthropic', 'claude_code_oauth', {
      oauthToken: 'sk-ant-oat-upstream',
    });
    const upstreamFetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: 'gtw_forged_not_issued_by_broker',
      });

      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(response.status).toBeLessThan(404);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('honors numeric loopback bind hosts only', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const broker = new GantryModelGatewayBroker(repo, {
      bindHost: '::1',
    });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      expect(injection.env[anthropicBaseUrlKey]).toMatch(
        /^http:\/\/\[::1\]:\d+\/anthropic$/,
      );
    } finally {
      await broker.close();
    }

    expect(
      () => new GantryModelGatewayBroker(repo, { bindHost: 'localhost' }),
    ).toThrow('numeric loopback');
    expect(
      () => new GantryModelGatewayBroker(repo, { bindHost: '0.0.0.0' }),
    ).toThrow('numeric loopback');
  });

  it('authenticates run tokens and rejects them after credential rotation', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-old');
    const upstreamFetch = vi.fn(async () => new Response('{"ok":true}'));
    const audit = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo, { audit });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:credential-audit' as never,
          modelRouteId: 'anthropic',
        },
      });
      const unauthorized = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: 'gtw_wrong',
      });
      expect(unauthorized.status).toBe(401);

      const response = await gatewayRequest({
        url: `${injection.env[['ANTHROPIC', 'BASE_URL'].join('_')]}/v1/messages`,
        token: injection.env[['ANTHROPIC', 'API_KEY'].join('_')]!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://api.anthropic.com/v1/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-old',
          }),
        }),
      );
      repo.set('anthropic', 'sk-ant-new');
      const afterRotate = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });
      expect(afterRotate.status).toBe(401);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          appId,
          runId: 'run:credential-audit',
          eventType: 'credential.model.used',
          actor: 'gantry-model-gateway',
          payload: expect.objectContaining({
            providerId: 'anthropic',
            outcome: 'forwarded',
            status: 200,
            upstreamHost: 'api.anthropic.com',
            upstreamPath: '/v1/messages',
          }),
        }),
      );
      expect(JSON.stringify(audit.mock.calls)).not.toContain('sk-ant-old');

      await broker.revokeInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:credential-audit' as never,
          modelRouteId: 'anthropic',
        },
      });
      const afterRevoke = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });
      expect(afterRevoke.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it('does not publish ephemeral credential revocation scopes as runtime run ids', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-old');
    const audit = vi.fn(async () => undefined);
    const broker = new GantryModelGatewayBroker(repo, { audit });
    try {
      await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'credential-run:ephemeral' as never,
          modelRouteId: 'anthropic',
        },
      });

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          appId,
          eventType: 'credential.model.used',
          actor: 'gantry-model-gateway',
          payload: expect.objectContaining({
            providerId: 'anthropic',
            outcome: 'token_issued',
          }),
        }),
      );
      expect(audit.mock.calls[0]?.[0]).not.toHaveProperty('runId');
    } finally {
      await broker.close();
    }
  });

  it('does not publish synthetic memory query scopes as runtime run ids', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-old');
    const audit = vi.fn(async () => undefined);
    const broker = new GantryModelGatewayBroker(repo, { audit });
    try {
      await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'memory-query:ephemeral' as never,
          modelRouteId: 'anthropic',
        },
      });

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          appId,
          eventType: 'credential.model.used',
          actor: 'gantry-model-gateway',
          payload: expect.objectContaining({
            providerId: 'anthropic',
            outcome: 'token_issued',
          }),
        }),
      );
      expect(audit.mock.calls[0]?.[0]).not.toHaveProperty('runId');
    } finally {
      await broker.close();
    }
  });

  it('streams upstream provider responses without buffering the full body', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-stream');
    let releaseSecondChunk!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from('data: first\n\n'));
                releaseSecondChunk = () => {
                  controller.enqueue(Buffer.from('data: second\n\n'));
                  controller.close();
                };
              },
            }),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          ),
      ),
    );
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = gatewayStreamingRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });

      await expect(response.firstChunk).resolves.toBe('data: first\n\n');
      releaseSecondChunk();
      await expect(response.done).resolves.toMatchObject({
        status: 200,
        body: 'data: first\n\ndata: second\n\n',
      });
    } finally {
      await broker.close();
    }
  });

  it('strips stale compression and length headers from upstream responses', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-compressed');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"ok":true}', {
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': '999',
            },
          }),
      ),
    );
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe('{"ok":true}');
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-length']).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('hot-resolves disabled provider credentials after a token is issued', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-active');
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      repo.disable('anthropic');

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });

      expect(response.status).toBe(503);
      expect(response.body).toContain(
        'No active anthropic model credential is configured',
      );
    } finally {
      await broker.close();
    }
  });

  it('rejects expired run-scoped gateway tokens', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const broker = new GantryModelGatewayBroker(repo, { tokenTtlMs: -1 });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain('Unauthorized model gateway request');
    } finally {
      await broker.close();
    }
  });

  it('requires app-scoped bindings for token issue and revocation', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}')),
    );
    const broker = new GantryModelGatewayBroker(repo);
    try {
      await expect(
        broker.getInjection({
          binding: {
            profile: 'gantry',
            purpose: 'model_runtime',
            modelRouteId: 'anthropic',
          },
        }),
      ).rejects.toThrow('requires appId');

      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:scoped-revoke' as never,
          modelRouteId: 'anthropic',
        },
      });
      await expect(
        broker.revokeInjection({
          binding: {
            profile: 'gantry',
            purpose: 'model_runtime',
            appId,
            modelRouteId: 'anthropic',
          },
        }),
      ).rejects.toThrow('requires runId');

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });
      expect(response.status).toBe(200);
    } finally {
      await broker.close();
    }
  });

  it('rejects method and path attempts outside the provider route before upstream fetch', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('openrouter', 'sk-or-upstream');
    const upstreamFetch = vi.fn(async () => new Response('should not call'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:path-method' as never,
          modelRouteId: 'openrouter',
        },
      });

      // OpenRouter now projects the OpenAI-family gateway env (DeepAgents lane).
      const wrongMethod = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
        method: 'GET',
      });
      expect(wrongMethod.status).toBe(405);

      const traversal = await gatewayRawPathRequest({
        baseUrl: injection.env.OPENAI_BASE_URL!,
        path: '/api/%2e%2e/v1/chat/completions',
        token: injection.env.OPENAI_API_KEY!,
      });
      expect(traversal.status).toBe(400);

      // /v1/messages is the Anthropic SDK lane; it is no longer allowed for the
      // OpenAI-compatible OpenRouter route.
      const disallowedMessages = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/messages`,
        token: injection.env.OPENAI_API_KEY!,
      });
      expect(disallowedMessages.status).toBe(400);

      const disallowedPath = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/anything`,
        token: injection.env.OPENAI_API_KEY!,
      });
      expect(disallowedPath.status).toBe(400);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('proxies OpenRouter chat-completions traffic upstream with bearer auth', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('openrouter', 'sk-or-chat-upstream');
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:openrouter-chat' as never,
          modelRouteId: 'openrouter',
        },
      });

      expect(injection.env.OPENAI_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/openrouter$/,
      );
      expect(injection.env.OPENAI_API_KEY).toMatch(/^gtw_/);
      expect(injection.env.OPENAI_API_KEY).not.toContain('sk-or');

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://openrouter.ai/api/v1/chat/completions'),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer sk-or-chat-upstream',
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it('allowlists proxy headers in both directions', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const upstreamFetch = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=leak',
            server: 'upstream',
          },
        }),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:headers' as never,
          modelRouteId: 'anthropic',
        },
      });
      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
        headers: {
          cookie: 'agent-cookie=leak',
          'proxy-authorization': 'Basic leak',
          'x-forwarded-for': '10.0.0.1',
          origin: 'https://agent.example',
          'anthropic-version': '2023-06-01',
        },
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            cookie: expect.any(String),
            'proxy-authorization': expect.any(String),
            'x-forwarded-for': expect.any(String),
            origin: expect.any(String),
          }),
        }),
      );
      expect(upstreamFetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            'anthropic-version': '2023-06-01',
            'x-api-key': 'sk-ant-upstream',
          }),
        }),
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers.server).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('fails closed when a route credential is missing', async () => {
    const broker = new GantryModelGatewayBroker(
      new MutableModelCredentialRepository(),
    );

    await expect(
      broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'openrouter',
        },
      }),
    ).rejects.toThrow('gantry credentials model set openrouter');
  });

  it('fails closed before upstream fetch for unsupported auth strategies', async () => {
    const provider = getModelProviderDefinition('anthropic')!;
    const originalModes = provider.credentialModes;
    const unsupportedMode: ModelCredentialModeDefinition = {
      ...originalModes[0]!,
      id: 'aws_default_chain',
      label: 'AWS default chain',
      helpText: 'Synthetic unsupported strategy.',
      fields: [
        {
          name: 'region',
          label: 'AWS region',
          secret: false,
          required: true,
        },
      ],
      gatewayAuth: { strategy: 'aws_sdk_default_chain' },
    };
    (
      provider as { credentialModes: readonly ModelCredentialModeDefinition[] }
    ).credentialModes = [unsupportedMode];
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('anthropic', 'aws_default_chain', { region: 'us-east-1' });
    const upstreamFetch = vi.fn(async () => new Response('should not call'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      });

      expect(response.status).toBe(502);
      expect(response.body).toContain(
        'Model gateway auth strategy aws_sdk_default_chain is not implemented',
      );
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
      (
        provider as {
          credentialModes: readonly ModelCredentialModeDefinition[];
        }
      ).credentialModes = originalModes;
    }
  });

  it('proxies OpenAI chat-completions traffic for the DeepAgents lane', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('openai', 'sk-openai-chat-upstream');
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'openai',
        },
      });

      expect(injection.env.OPENAI_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/openai$/,
      );
      expect(injection.env.OPENAI_API_KEY).toMatch(/^gtw_/);

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://api.openai.com/v1/chat/completions'),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer sk-openai-chat-upstream',
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it('rejects disallowed OpenAI paths before the upstream fetch', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('openai', 'sk-openai-upstream');
    const upstreamFetch = vi.fn(async () => new Response('should not call'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'openai',
        },
      });

      const disallowed = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/files`,
        token: injection.env.OPENAI_API_KEY!,
      });
      expect(disallowed.status).toBe(400);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it.each([
    ['groq', 'groq', 'https://api.groq.com/openai/v1/chat/completions'],
    [
      'fireworks',
      'fireworks',
      'https://api.fireworks.ai/inference/v1/chat/completions',
    ],
    ['perplexity', 'perplexity', 'https://api.perplexity.ai/chat/completions'],
    [
      'gemini',
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ],
  ])(
    'maps loopback /%s/chat/completions to the exact upstream URL with bearer auth',
    async (providerId, pathSegment, upstreamUrl) => {
      // PATH COMPOSITION PROOF: ChatOpenAI posts `<loopback base>/chat/
      // completions` where the base is the raw OPENAI_BASE_URL projection
      // (http://127.0.0.1:<port>/<segment>, no /v1). The gateway prepends each
      // provider's real upstreamPathPrefix to produce the upstream URL.
      const repo = new MutableModelCredentialRepository();
      repo.set(providerId as ModelCredentialProvider, `sk-${providerId}-up`);
      const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
      vi.stubGlobal('fetch', upstreamFetch);
      const broker = new GantryModelGatewayBroker(repo);
      try {
        const injection = await broker.getInjection({
          binding: {
            profile: 'gantry',
            purpose: 'model_runtime',
            appId,
            modelCredentialProviderId: providerId as ModelCredentialProvider,
          },
        });

        expect(injection.env.OPENAI_BASE_URL).toBe(
          `${new URL(injection.env.OPENAI_BASE_URL!).origin}/${pathSegment}`,
        );
        expect(injection.env.OPENAI_API_KEY).toMatch(/^gtw_/);

        // The exact path the OpenAI SDK posts: `<base>/chat/completions`.
        const response = await gatewayRequest({
          url: `${injection.env.OPENAI_BASE_URL}/chat/completions`,
          token: injection.env.OPENAI_API_KEY!,
        });

        expect(response.status).toBe(200);
        expect(upstreamFetch).toHaveBeenCalledWith(
          new URL(upstreamUrl),
          expect.objectContaining({
            headers: expect.objectContaining({
              authorization: `Bearer sk-${providerId}-up`,
            }),
          }),
        );
      } finally {
        await broker.close();
      }
    },
  );

  it('routes Bedrock API-key mode through the regional OpenAI-compatible endpoint without forwarding client auth headers', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('bedrock', 'bedrock_api_key', {
      region: 'us-east-1',
      apiKey: 'bedrock-upstream-key',
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'bedrock',
        },
      });

      expect(injection.env.OPENAI_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/bedrock$/,
      );
      expect(injection.env.OPENAI_API_KEY).toMatch(/^gtw_/);

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
        headers: {
          'x-amz-security-token': 'runner-controlled',
          'x-goog-user-project': 'runner-project',
        },
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL(
          'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions',
        ),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer bedrock-upstream-key',
          }),
        }),
      );
      const headers = upstreamFetch.mock.calls[0]![1]!.headers as Record<
        string,
        string
      >;
      expect(headers['x-amz-security-token']).toBeUndefined();
      expect(headers['x-goog-user-project']).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('rejects Bedrock access-key mode on the OpenAI-compatible provider route', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('bedrock', 'access_key', {
      region: 'us-east-1',
      accessKeyId: 'AKIATESTACCESSKEY',
      secretAccessKey: 'test-secret-access-key',
      sessionToken: 'session-token',
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      await expect(
        broker.getInjection({
          binding: {
            profile: 'gantry',
            purpose: 'model_runtime',
            appId,
            modelCredentialProviderId: 'bedrock',
          },
        }),
      ).rejects.toThrow(
        'Credential auth mode access_key is not supported for bedrock.',
      );
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('routes Vertex service-account mode through the documented OpenAI-compatible location endpoint with a minted OAuth token', async () => {
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      project_id: 'gantry-test',
      client_email: 'gantry-test@example.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
    });
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('vertex', 'service_account', {
      region: 'global',
      projectId: 'gantry-test',
      serviceAccountJson,
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'vertex',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(vertexGetAccessTokenMock).toHaveBeenCalledTimes(1);
      expect(googleAuthOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({
            project_id: 'gantry-test',
            client_email: 'gantry-test@example.iam.gserviceaccount.com',
          }),
        }),
      );
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL(
          'https://aiplatform.googleapis.com/v1/projects/gantry-test/locations/global/endpoints/openapi/chat/completions',
        ),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer ya29.vertex-token',
          }),
        }),
      );
      const headers = upstreamFetch.mock.calls[0]![1]!.headers as Record<
        string,
        string
      >;
      expect(JSON.stringify(headers)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(headers)).not.toContain(serviceAccountJson);
    } finally {
      await broker.close();
    }
  });

  it('rejects non-global Vertex locations before upstream fetch', async () => {
    const serviceAccountJson = vertexServiceAccountJson('gantry-test');
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('vertex', 'service_account', {
      region: 'us',
      projectId: 'gantry-test',
      serviceAccountJson,
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'vertex',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain('Google Cloud location is invalid.');
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(vertexGetAccessTokenMock).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('routes Vertex service-account JSON from a different owner project', async () => {
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      project_id: 'other-project',
      client_email: 'other-project@example.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
    });
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('vertex', 'service_account', {
      region: 'global',
      projectId: 'gantry-test',
      serviceAccountJson,
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'vertex',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(vertexGetAccessTokenMock).toHaveBeenCalledTimes(1);
      expect(googleAuthOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({
            project_id: 'other-project',
            client_email: 'other-project@example.iam.gserviceaccount.com',
            token_uri: 'https://oauth2.googleapis.com/token',
          }),
        }),
      );
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL(
          'https://aiplatform.googleapis.com/v1/projects/gantry-test/locations/global/endpoints/openapi/chat/completions',
        ),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer ya29.vertex-token',
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it('rejects a malicious Vertex service-account token URI before upstream fetch', async () => {
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      project_id: 'other-project',
      client_email: 'other-project@example.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
      token_uri: 'https://evil.example/token',
    });
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('vertex', 'service_account', {
      region: 'global',
      projectId: 'gantry-test',
      serviceAccountJson,
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'vertex',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(502);
      expect(response.body).toContain(
        'Invalid Vertex service account credential.',
      );
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(googleAuthOptionsMock).not.toHaveBeenCalled();
      expect(vertexGetAccessTokenMock).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('rejects a disallowed path on an OpenAI-compatible DeepAgents provider before upstream fetch', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('groq', 'sk-groq-up');
    const upstreamFetch = vi.fn(async () => new Response('should not call'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'groq',
        },
      });

      // /chat/completions and /v1/chat/completions are allowed; anything else
      // (here the Anthropic SDK lane path) is rejected before upstream fetch.
      const disallowed = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/messages`,
        token: injection.env.OPENAI_API_KEY!,
      });
      expect(disallowed.status).toBe(400);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('proxies OpenAI embedding traffic through the same gateway boundary', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('openai', 'sk-openai-upstream');
    const upstreamFetch = vi.fn(async () => new Response('{"data":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'openai',
        },
      });

      expect(injection.env.OPENAI_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/openai$/,
      );
      expect(injection.env.OPENAI_API_KEY).toMatch(/^gtw_/);
      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/embeddings`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://api.openai.com/v1/embeddings'),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer sk-openai-upstream',
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it('blocks requests after the per-provider per-minute cap and audits the rejection', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-cap');
    const upstreamFetch = vi.fn(async () => new Response('{"ok":true}'));
    const audit = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo, {
      audit,
      limits: () => ({ providers: { anthropic: { requestsPerMinute: 2 } } }),
    });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      const url = `${injection.env[anthropicBaseUrlKey]}/v1/messages`;
      const token = injection.env[anthropicApiKeyKey]!;

      const first = await gatewayRequest({ url, token });
      const second = await gatewayRequest({ url, token });
      const third = await gatewayRequest({ url, token });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.body).toContain(
        'Rate limit: anthropic exceeded 2 requests/min for this app.',
      );
      // The rejected request never forwarded upstream (only the 2 admitted did).
      expect(upstreamFetch).toHaveBeenCalledTimes(2);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          appId,
          eventType: 'credential.model.used',
          actor: 'gantry-model-gateway',
          payload: expect.objectContaining({
            providerId: 'anthropic',
            outcome: 'rate_limited',
            status: 429,
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it('does not mint a Vertex token for requests rejected by the rate cap', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('vertex', 'service_account', {
      region: 'global',
      projectId: 'gantry-test',
      serviceAccountJson: vertexServiceAccountJson('gantry-test'),
    });
    const upstreamFetch = vi.fn(async () => new Response('{"choices":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo, {
      limits: () => ({ providers: { vertex: { requestsPerMinute: 1 } } }),
    });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'vertex',
        },
      });
      const url = `${injection.env.OPENAI_BASE_URL}/chat/completions`;
      const token = injection.env.OPENAI_API_KEY!;

      expect((await gatewayRequest({ url, token })).status).toBe(200);
      expect(vertexGetAccessTokenMock).toHaveBeenCalledTimes(1);

      clearVertexTokenCacheForTest();
      vertexGetAccessTokenMock.mockClear();
      googleAuthOptionsMock.mockClear();
      upstreamFetch.mockClear();

      const rejected = await gatewayRequest({ url, token });

      expect(rejected.status).toBe(429);
      expect(rejected.body).toContain(
        'Rate limit: vertex exceeded 1 requests/min for this app.',
      );
      expect(googleAuthOptionsMock).not.toHaveBeenCalled();
      expect(vertexGetAccessTokenMock).not.toHaveBeenCalled();
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('admits requests again after the rate window rolls', async () => {
    // Fake only Date so the broker's sliding-window clock advances while the
    // real HTTP server / fetch I/O keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-14T00:00:00Z'));
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-window');
    const upstreamFetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo, {
      limits: () => ({ providers: { anthropic: { requestsPerMinute: 1 } } }),
    });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      const url = `${injection.env[anthropicBaseUrlKey]}/v1/messages`;
      const token = injection.env[anthropicApiKeyKey]!;

      expect((await gatewayRequest({ url, token })).status).toBe(200);
      // Second within the same window -> blocked.
      expect((await gatewayRequest({ url, token })).status).toBe(429);
      // Advance past the 60s window -> admitted again.
      vi.setSystemTime(new Date('2026-06-14T00:01:01Z'));
      expect((await gatewayRequest({ url, token })).status).toBe(200);
    } finally {
      await broker.close();
      vi.useRealTimers();
    }
  });
});

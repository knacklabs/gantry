import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';

import { GantryModelGatewayBroker } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway.js';
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

describe('GantryModelGatewayBroker', () => {
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

      const wrongMethod = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
        method: 'GET',
      });
      expect(wrongMethod.status).toBe(405);

      const traversal = await gatewayRawPathRequest({
        baseUrl: injection.env[anthropicBaseUrlKey]!,
        path: '/api/%2e%2e/v1/messages',
        token: injection.env[anthropicApiKeyKey]!,
      });
      expect(traversal.status).toBe(400);

      const disallowedPath = await gatewayRequest({
        url: `${injection.env[anthropicBaseUrlKey]}/v1/anything`,
        token: injection.env[anthropicApiKeyKey]!,
      });
      expect(disallowedPath.status).toBe(400);
      expect(upstreamFetch).not.toHaveBeenCalled();
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
      id: 'sigv4',
      label: 'SigV4',
      helpText: 'Synthetic unsupported strategy.',
      gatewayAuth: { strategy: 'aws_sigv4' },
    };
    (
      provider as { credentialModes: readonly ModelCredentialModeDefinition[] }
    ).credentialModes = [unsupportedMode];
    const repo = new MutableModelCredentialRepository();
    repo.setWithMode('anthropic', 'sigv4', { apiKey: 'unused-secret' });
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
        'Model gateway auth strategy aws_sigv4 is not implemented',
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
});

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { handleLlmRoutes } from '@core/control/server/routes/llm.js';
import {
  configureControlRequestLogSink,
  type ControlRequestLogEntry,
} from '@core/control/server/http.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/shared/control-api-keys.js';
import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';

const TOKEN = 'llm-route-token';
const messagesProviderEnvPrefix = ['ANTH', 'ROPIC'].join('');
const chatProviderEnvPrefix = ['OPEN', 'AI'].join('');
const messagesBaseUrlKey = [messagesProviderEnvPrefix, 'BASE_URL'].join('_');
const messagesTokenKey = [messagesProviderEnvPrefix, 'API_KEY'].join('_');
const chatBaseUrlKey = [chatProviderEnvPrefix, 'BASE_URL'].join('_');
const chatTokenKey = [chatProviderEnvPrefix, 'API_KEY'].join('_');

class TestResponse extends Writable {
  statusCode = 0;
  readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private sentHeaders = false;

  get headersSent(): boolean {
    return this.sentHeaders;
  }

  setHeader(name: string, value: number | string | string[]) {
    this.headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
    return this;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.sentHeaders = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

let restoreLogSink: () => void = () => undefined;
let requestLogs: ControlRequestLogEntry[] = [];

beforeEach(() => {
  requestLogs = [];
  restoreLogSink = configureControlRequestLogSink((entry) => {
    requestLogs.push(entry);
  });
});

afterEach(() => {
  restoreLogSink();
  vi.unstubAllGlobals();
});

function request(input: {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const raw =
    typeof input.body === 'string'
      ? input.body
      : JSON.stringify(input.body ?? {});
  const req = Readable.from([raw]) as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = {
    authorization: `Bearer ${input.token ?? TOKEN}`,
    'content-type': 'application/json',
    ...(input.headers ?? {}),
  };
  return req;
}

function apiKey(scopes: Scope[] = ['llm:invoke'], maxTokens?: number) {
  return {
    kid: 'llm-key',
    tokenHash: createHash('sha256').update(TOKEN).digest(),
    scopes: new Set(scopes),
    appId: 'app-one',
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function broker(): AgentCredentialBroker {
  return {
    getInjection: vi.fn(async (input) => {
      const route = input.binding.modelRouteId;
      return {
        env:
          route === 'anthropic'
            ? {
                [messagesBaseUrlKey]: 'http://127.0.0.1:9000/anthropic',
                [messagesTokenKey]: 'gtw_anthropic',
              }
            : {
                [chatBaseUrlKey]: `http://127.0.0.1:9000/${route}`,
                [chatTokenKey]: 'gtw_openai',
              },
        applied: true,
        brokerProfile: 'gantry',
      };
    }),
    revokeInjection: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({
      status: 'pass',
      message: 'ok',
    })),
    getCapabilities: () => ({
      profile: 'gantry',
      supportsAgentBinding: false,
      returnsRawSecrets: true,
    }),
  };
}

function context(input: {
  broker: AgentCredentialBroker;
  scopes?: Scope[];
  consume?: boolean;
  maxTokens?: number;
}): ControlRouteContext {
  return {
    app: {
      getCredentialBroker: async () => input.broker,
    } as RuntimeApp,
    runtimeHome: '/tmp/gantry',
    keys: [apiKey(input.scopes, input.maxTokens)],
    processRole: 'all',
    liveExecution: true,
    roleReadinessRequirements: {
      requiresApiAuthConfigured: false,
      requiresWorkerRegistration: false,
      requiresSchedulerClaiming: false,
      requiresLiveCapacitySignal: false,
    },
    socketPath: '/tmp/gantry/control.sock',
    port: 0,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
    triggerRateLimiter: {
      consume: vi.fn(() => input.consume ?? true),
    },
    getRuntimeSettings: () => ({}) as never,
    getInternalRuntimeSettings: () => ({}) as never,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () => ({ defaults: {} }) as never,
    patchModelDefaults: async () => ({ ok: true }),
    preflightModelProvider: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    getActiveModelCredentialProviderIds: async () => [],
    countPendingAccessRequests: async () => 0,
    listControlPlaneJobs: async () => [],
    syncSettingsFromProjection: async () => undefined,
    getSelectedAgentHarness: () => 'auto',
  };
}

describe('direct LLM control routes', () => {
  it('forwards Anthropic Messages requests through an API-key-scoped gateway token', async () => {
    const gatewayBroker = broker();
    const fetchMock = vi.fn(
      async () =>
        new Response('{"id":"msg_1"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_1',
            authorization: 'must-not-forward',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = request({
      body: {
        model: 'sonnet',
        max_tokens: 32,
        system: 'Stable instructions',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Unique content' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aGVsbG8=',
                },
              },
            ],
          },
        ],
      },
      headers: { 'anthropic-version': '2023-06-01' },
    });
    const res = new TestResponse();

    await expect(
      handleLlmRoutes(
        req,
        res as unknown as ServerResponse,
        context({ broker: gatewayBroker }),
        '/llm/v1/messages',
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-request-id']).toBe('req_1');
    expect(res.headers.authorization).toBeUndefined();
    expect(res.body()).toBe('{"id":"msg_1"}');

    expect(gatewayBroker.getInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        appId: 'app-one',
        apiKeyId: 'llm-key',
        modelRouteId: 'anthropic',
      }),
    });
    expect(gatewayBroker.getInjection).toHaveBeenCalledWith({
      binding: expect.not.objectContaining({ runId: expect.anything() }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/anthropic/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer gtw_anthropic',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    const upstreamBody = JSON.parse(
      Buffer.from(fetchMock.mock.calls[0]![1]!.body as Buffer).toString('utf8'),
    );
    expect(upstreamBody.model).toBe('claude-sonnet-4-6');
    expect(upstreamBody.system).toEqual([
      {
        type: 'text',
        text: 'Stable instructions',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ]);
    expect(upstreamBody.messages[0].content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'aGVsbG8=',
      },
    });
    const upstreamSignal = fetchMock.mock.calls[0]![1]!.signal as AbortSignal;
    expect(upstreamSignal.aborted).toBe(false);
    req.emit('close');
    res.emit('close');
    expect(upstreamSignal.aborted).toBe(false);
    expect(gatewayBroker.revokeInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        apiKeyId: 'llm-key',
        modelRouteId: 'anthropic',
      }),
    });
    expect(requestLogs).toContainEqual(
      expect.objectContaining({
        route: '/llm/v1/messages',
        apiKeyId: 'llm-key',
        appId: 'app-one',
        modelAlias: 'sonnet',
        modelRouteId: 'anthropic',
        statusCode: 200,
      }),
    );
  });

  it('forwards Messages token counts and returns the provider response', async () => {
    const gatewayBroker = broker();
    const fetchMock = vi.fn(
      async () =>
        new Response('{"input_tokens":9}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = new TestResponse();
    await handleLlmRoutes(
      request({
        body: {
          model: 'sonnet',
          messages: [{ role: 'user', content: 'count me' }],
        },
      }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker, maxTokens: 32 }),
      '/llm/v1/messages/count_tokens',
    );
    expect(res.statusCode).toBe(200);
    expect(res.body()).toBe('{"input_tokens":9}');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/anthropic/v1/messages/count_tokens',
      expect.objectContaining({ method: 'POST' }),
    );
    const forwarded = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(forwarded.model).toBe('claude-sonnet-4-6');
    expect(requestLogs).toContainEqual(
      expect.objectContaining({
        route: '/llm/v1/messages/count_tokens',
        apiKeyId: 'llm-key',
        modelAlias: 'sonnet',
        statusCode: 200,
      }),
    );
  });

  it.each([
    {
      name: 'Messages over the limit',
      path: '/llm/v1/messages',
      maxTokens: 32,
      body: { model: 'sonnet', max_tokens: 33 },
      status: 400,
      requested: 33,
    },
    {
      name: 'Messages at the limit',
      path: '/llm/v1/messages',
      maxTokens: 32,
      body: { model: 'sonnet', max_tokens: 32 },
      status: 200,
    },
    {
      name: 'unlimited Messages',
      path: '/llm/v1/messages',
      maxTokens: undefined,
      body: { model: 'sonnet', max_tokens: 1000 },
      status: 200,
    },
    {
      name: 'missing Chat Completions limit on a limited key',
      path: '/llm/v1/chat/completions',
      maxTokens: 32,
      body: { model: 'gpt' },
      status: 400,
    },
    {
      name: 'missing Chat Completions limit on an unlimited key',
      path: '/llm/v1/chat/completions',
      maxTokens: undefined,
      body: { model: 'gpt' },
      status: 200,
    },
    {
      name: 'multiple Chat Completions choices over the limit',
      path: '/llm/v1/chat/completions',
      maxTokens: 32,
      body: { model: 'gpt', max_tokens: 32, n: 2 },
      status: 400,
      requested: 64,
    },
    {
      name: 'one Chat Completions choice at the limit',
      path: '/llm/v1/chat/completions',
      maxTokens: 32,
      body: { model: 'gpt', max_tokens: 32, n: 1 },
      status: 200,
    },
  ])(
    'enforces the API-key output limit: $name',
    async ({ path, maxTokens, body, requested, status }) => {
      const gatewayBroker = broker();
      const fetchMock = vi.fn(
        async () => new Response('{"id":"msg_limited"}', { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const res = new TestResponse();
      await handleLlmRoutes(
        request({ body }),
        res as unknown as ServerResponse,
        context({ broker: gatewayBroker, maxTokens }),
        path,
      );
      expect(res.statusCode).toBe(status);
      if (status === 400) {
        const response = JSON.parse(res.body());
        expect(response).toMatchObject({
          error: {
            code: 'MAX_TOKENS_EXCEEDED',
            details: { field: 'max_tokens', limit: maxTokens },
          },
        });
        if (requested === undefined) {
          expect(response.error.details).not.toHaveProperty('requested');
        } else {
          expect(response.error.details.requested).toBe(requested);
        }
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    },
  );

  it('forwards OpenAI Chat Completions streaming responses without buffering', async () => {
    const gatewayBroker = broker();
    const fetchMock = vi.fn(
      async () =>
        new Response('data: {"choices":[]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = request({
      body: {
        model: 'gpt',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'medium',
      },
    });
    const res = new TestResponse();

    await handleLlmRoutes(
      req,
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/chat/completions',
    );

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body()).toBe('data: {"choices":[]}\n\n');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/openai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer gtw_openai',
        }),
      }),
    );
    const upstreamBody = JSON.parse(
      Buffer.from(fetchMock.mock.calls[0]![1]!.body as Buffer).toString('utf8'),
    );
    expect(upstreamBody.model).toBe('gpt-5.5');
    expect(upstreamBody.tools[0].type).toBe('function');
    expect(upstreamBody.response_format).toEqual({ type: 'json_object' });
    expect(upstreamBody.reasoning_effort).toBe('medium');
  });

  it.each([
    {
      name: 'Anthropic server tool',
      path: '/llm/v1/messages',
      body: {
        model: 'sonnet',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
      field: 'tools[0].type',
      detail: 'web_search_20250305',
    },
    {
      name: 'Anthropic MCP servers',
      path: '/llm/v1/messages',
      body: { model: 'sonnet', mcp_servers: [] },
      field: 'mcp_servers',
    },
    {
      name: 'Anthropic container',
      path: '/llm/v1/messages',
      body: { model: 'sonnet', container: 'container_1' },
      field: 'container',
    },
    {
      name: 'Anthropic execution beta',
      path: '/llm/v1/messages',
      body: { model: 'sonnet', betas: ['computer-use-2025-01-24'] },
      field: 'betas[0]',
      detail: 'computer-use-2025-01-24',
    },
    {
      name: 'OpenAI hosted tool',
      path: '/llm/v1/chat/completions',
      body: { model: 'gpt', tools: [{ type: 'file_search' }] },
      field: 'tools[0].type',
      detail: 'file_search',
    },
    {
      name: 'OpenAI hosted field',
      path: '/llm/v1/chat/completions',
      body: { model: 'gpt', web_search_options: {} },
      field: 'web_search_options',
    },
    {
      name: 'OpenAI file attachment',
      path: '/llm/v1/chat/completions',
      body: { model: 'gpt', messages: [{ role: 'user', attachments: [] }] },
      field: 'messages[0].attachments',
    },
  ])('rejects $name with a shaped unsupported-field error', async (input) => {
    const gatewayBroker = broker();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: input.body }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      input.path,
    );

    expect(res.statusCode).toBe(400);
    const response = JSON.parse(res.body());
    expect(response).toMatchObject({
      error: {
        code: 'UNSUPPORTED_FIELD',
        details: { field: input.field },
        retryable: false,
      },
    });
    expect(response.error.message).toContain(input.field);
    if (input.detail) expect(response.error.message).toContain(input.detail);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });

  it('returns a shaped unavailable error when gateway setup fails', async () => {
    const gatewayBroker = broker();
    vi.mocked(gatewayBroker.getInjection).mockRejectedValueOnce(
      new Error('Model credential for anthropic is not configured.'),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body())).toMatchObject({
      error: { code: 'MODEL_GATEWAY_UNAVAILABLE', retryable: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayBroker.revokeInjection).not.toHaveBeenCalled();
    expect(requestLogs).toContainEqual(
      expect.objectContaining({ statusCode: 503, modelAlias: 'sonnet' }),
    );
  });

  it('returns a shaped unavailable error when the gateway fetch fails', async () => {
    const gatewayBroker = broker();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed')),
    );
    const res = new TestResponse();

    await expect(
      handleLlmRoutes(
        request({ body: { model: 'sonnet' } }),
        res as unknown as ServerResponse,
        context({ broker: gatewayBroker }),
        '/llm/v1/messages',
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body())).toMatchObject({
      error: { code: 'MODEL_GATEWAY_UNAVAILABLE', retryable: true },
    });
    expect(gatewayBroker.revokeInjection).toHaveBeenCalledOnce();
    expect(requestLogs).toContainEqual(
      expect.objectContaining({ statusCode: 502, modelAlias: 'sonnet' }),
    );
  });

  it('ends a failed gateway stream without appending a JSON error', async () => {
    const gatewayBroker = broker();
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pullCount++ === 0) {
          controller.enqueue(Buffer.from('data: first\n\n'));
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.error(new Error('gateway stream reset'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      ),
    );
    const res = new TestResponse();

    await expect(
      handleLlmRoutes(
        request({ body: { model: 'gpt', stream: true } }),
        res as unknown as ServerResponse,
        context({ broker: gatewayBroker }),
        '/llm/v1/chat/completions',
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body()).toBe('data: first\n\n');
    expect(res.writableEnded).toBe(true);
    expect(gatewayBroker.revokeInjection).toHaveBeenCalledOnce();
    expect(requestLogs).toContainEqual(
      expect.objectContaining({ statusCode: 502, modelAlias: 'gpt' }),
    );
  });

  it('aborts the gateway and preserves cleanup when the client disconnects mid-stream', async () => {
    const gatewayBroker = broker();
    let upstreamSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(Buffer.from('data: first\n\n'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? undefined;
        upstreamSignal?.addEventListener(
          'abort',
          () => streamController.error(upstreamSignal?.reason),
          { once: true },
        );
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    const req = request({ body: { model: 'gpt', stream: true } });
    const res = new TestResponse();

    const route = handleLlmRoutes(
      req,
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/chat/completions',
    );
    await vi.waitFor(() => expect(res.body()).toBe('data: first\n\n'));
    res.emit('close');

    await expect(route).resolves.toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.body()).toBe('data: first\n\n');
    expect(requestLogs).toContainEqual(
      expect.objectContaining({
        statusCode: 200,
        modelAlias: 'gpt',
        clientDisconnected: true,
      }),
    );
    expect(gatewayBroker.revokeInjection).toHaveBeenCalledOnce();
  });

  it('preserves request-caused gateway setup errors as 4xx responses', async () => {
    const gatewayBroker = broker();
    vi.mocked(gatewayBroker.getInjection).mockRejectedValueOnce(
      Object.assign(new Error('Gateway binding is invalid.'), {
        name: 'CredentialBrokerPolicyError',
        statusCode: 400,
        code: 'INVALID_REQUEST',
      }),
    );
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body())).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });
  });

  it('revokes an issued injection when its gateway projection is incomplete', async () => {
    const gatewayBroker = broker();
    vi.mocked(gatewayBroker.getInjection).mockResolvedValueOnce({
      env: {},
      applied: true,
      brokerProfile: 'gantry',
    });
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body())).toMatchObject({
      error: { code: 'MODEL_GATEWAY_UNAVAILABLE' },
    });
    expect(gatewayBroker.revokeInjection).toHaveBeenCalledOnce();
  });

  it('rejects invalid keys before broker access', async () => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' }, token: 'wrong' }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(401);
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });

  it.each(['/llm/v1/messages', '/llm/v1/messages/count_tokens'])(
    'requires llm:invoke scope on %s',
    async (path) => {
      const gatewayBroker = broker();
      const res = new TestResponse();

      await handleLlmRoutes(
        request({ body: { model: 'sonnet' } }),
        res as unknown as ServerResponse,
        context({ broker: gatewayBroker, scopes: ['sessions:read'] }),
        path,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body()).toContain('llm:invoke');
      expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/llm/v1/messages', 'claude-sonnet-4-6', 'Provider model ID'],
    ['/llm/v1/messages/count_tokens', 'claude-sonnet-4-6', 'Provider model ID'],
    ['/llm/v1/messages/count_tokens', 'missing-alias', 'Unknown model'],
  ])('rejects unregistered model %s', async (path, model, message) => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      path,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body()).toContain(message);
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });

  it('rejects models on the wrong endpoint shape', async () => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/chat/completions',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body()).toContain('Chat Completions');
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { getGantryOpenApiDocument } from '@core/control/server/openapi.js';
import { handleAgentRoutes } from '@core/control/server/routes/agents.js';
import { handleCapabilityCatalogRoutes } from '@core/control/server/routes/capability-catalog.js';
import { handleExternalIngressRoutes } from '@core/control/server/routes/external-ingress.js';
import { handleJobRoutes } from '@core/control/server/routes/jobs.js';
import { handleMemoryRoutes } from '@core/control/server/routes/memory.js';
import { handleMcpServerRoutes } from '@core/control/server/routes/mcp-servers.js';
import { handleModelRoutes } from '@core/control/server/routes/models.js';
import { handleOpenApiRoutes } from '@core/control/server/routes/openapi.js';
import { handleProviderConversationRoutes } from '@core/control/server/routes/provider-conversation-routes.js';
import { handleRunRoutes } from '@core/control/server/routes/runs.js';
import { handleSessionRoutes } from '@core/control/server/routes/sessions.js';
import { handleSettingsRoutes } from '@core/control/server/routes/settings.js';
import { handleSkillRoutes } from '@core/control/server/routes/skills.js';
import { handleSystemRoutes } from '@core/control/server/routes/system.js';
import { handleWebhookRoutes } from '@core/control/server/routes/webhooks.js';

const expectedControlRoutes = [
  'GET /v1/agents',
  'POST /v1/agents',
  'GET /v1/agents/{agentId}',
  'PATCH /v1/agents/{agentId}',
  'GET /v1/agents/{agentId}/admin',
  'GET /v1/agents/{agentId}/capabilities',
  'PUT /v1/agents/{agentId}/capabilities',
  'GET /v1/agents/{agentId}/conversation-bindings',
  'DELETE /v1/agents/{agentId}/conversation-bindings/{conversationId}',
  'PATCH /v1/agents/{agentId}/conversation-bindings/{conversationId}',
  'PUT /v1/agents/{agentId}/conversation-bindings/{conversationId}',
  'GET /v1/agents/{agentId}/mcp-servers',
  'DELETE /v1/agents/{agentId}/mcp-servers/{serverId}',
  'PATCH /v1/agents/{agentId}/mcp-servers/{serverId}',
  'PUT /v1/agents/{agentId}/mcp-servers/{serverId}',
  'GET /v1/agents/{agentId}/skills',
  'DELETE /v1/agents/{agentId}/skills/{skillId}',
  'PUT /v1/agents/{agentId}/skills/{skillId}',
  'GET /v1/agents/{agentId}/sources',
  'PUT /v1/agents/{agentId}/sources',
  'GET /v1/capabilities',
  'GET /v1/capabilities/{capabilityId}',
  'GET /v1/conversations',
  'GET /v1/conversations/{conversationId}',
  'GET /v1/conversations/{conversationId}/approvers',
  'PUT /v1/conversations/{conversationId}/approvers',
  'GET /v1/conversations/{conversationId}/messages',
  'GET /v1/conversations/{conversationId}/threads',
  'GET /v1/doctor',
  'GET /v1/health',
  'GET /v1/inventory',
  'GET /v1/ingresses',
  'POST /v1/ingresses',
  'DELETE /v1/ingresses/{ingressId}',
  'GET /v1/ingresses/{ingressId}',
  'PATCH /v1/ingresses/{ingressId}',
  'POST /v1/ingresses/{ingressId}/invoke',
  'POST /v1/ingresses/{ingressId}/rotate',
  'POST /v1/ingresses/{ingressId}/wait',
  'GET /v1/jobs',
  'POST /v1/jobs',
  'DELETE /v1/jobs/{jobId}',
  'GET /v1/jobs/{jobId}',
  'PATCH /v1/jobs/{jobId}',
  'GET /v1/jobs/{jobId}/events',
  'POST /v1/jobs/{jobId}/pause',
  'POST /v1/jobs/{jobId}/resume',
  'POST /v1/jobs/{jobId}/trigger',
  'GET /v1/mcp-servers',
  'GET /v1/mcp-servers/drafts',
  'POST /v1/mcp-servers/drafts',
  'POST /v1/mcp-servers/drafts/{serverId}/approve',
  'POST /v1/mcp-servers/drafts/{serverId}/reject',
  'POST /v1/mcp-servers/{serverId}/disable',
  'POST /v1/mcp-servers/{serverId}/test',
  'GET /v1/memory',
  'POST /v1/memory',
  'DELETE /v1/memory/{memoryId}',
  'PATCH /v1/memory/{memoryId}',
  'GET /v1/memory/dreaming/status',
  'POST /v1/memory/dreaming/trigger',
  'POST /v1/memory/search',
  'GET /v1/models',
  'GET /v1/models/defaults',
  'PATCH /v1/models/defaults',
  'POST /v1/models/preview',
  'GET /v1/provider-connections',
  'POST /v1/provider-connections',
  'DELETE /v1/provider-connections/{providerConnectionId}',
  'GET /v1/provider-connections/{providerConnectionId}',
  'PATCH /v1/provider-connections/{providerConnectionId}',
  'POST /v1/provider-connections/{providerConnectionId}/discover-conversations',
  'GET /v1/providers',
  'GET /v1/runs',
  'GET /v1/runs/{runId}',
  'GET /v1/runs/{runId}/events',
  'GET /v1/sessions/{sessionId}',
  'GET /v1/sessions/{sessionId}/events',
  'GET /v1/sessions/{sessionId}/messages',
  'POST /v1/sessions/{sessionId}/messages',
  'GET /v1/sessions/{sessionId}/runs',
  'GET /v1/sessions/{sessionId}/wait',
  'POST /v1/sessions/ensure',
  'GET /v1/settings',
  'PATCH /v1/settings',
  'GET /v1/skills/{skillId}/files',
  'GET /v1/skills/{skillId}/files/{filePath}',
  'GET /v1/skills/drafts',
  'POST /v1/skills/drafts/upload',
  'POST /v1/skills/drafts/{skillId}/approve',
  'POST /v1/skills/drafts/{skillId}/reject',
  'GET /v1/triggers/{triggerId}/wait',
  'GET /v1/webhooks',
  'POST /v1/webhooks',
  'DELETE /v1/webhooks/{webhookId}',
  'PATCH /v1/webhooks/{webhookId}',
  'POST /v1/webhooks/{webhookId}/purge-dead-letter',
  'POST /v1/webhooks/{webhookId}/replay-dead-letter',
  'POST /v1/webhooks/{webhookId}/test',
].sort();

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name: string, value: number | string | string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(', ')
        : String(value);
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as TestResponse;
}

function request(method: string): IncomingMessage {
  return {
    method,
    headers: {},
    on: () => undefined,
    once: () => undefined,
  } as unknown as IncomingMessage;
}

function documentedRoutes(): string[] {
  const spec = getGantryOpenApiDocument();
  return Object.entries(spec.paths)
    .flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function samplePath(pathname: string): string {
  return pathname.replace(/\{[^}]+\}/g, 'test-id');
}

function mockContext(): ControlRouteContext {
  return {
    app: {} as ControlRouteContext['app'],
    keys: [],
    socketPath: '/tmp/gantry-control.sock',
    port: 8787,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
    triggerRateLimiter: {
      consume: () => true,
    },
    getRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getRuntimeSettings']>,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () => ({
      defaults: {
        chat: {
          configuredAlias: null,
          effectiveAlias: null,
          source: 'test',
          workload: 'chat',
          modelEntry: null,
        },
        oneTime: {
          configuredAlias: null,
          effectiveAlias: null,
          source: 'test',
          workload: 'one_time_job',
          modelEntry: null,
        },
        recurring: {
          configuredAlias: null,
          effectiveAlias: null,
          source: 'test',
          workload: 'recurring_job',
          modelEntry: null,
        },
        memoryExtractor: {
          configuredAlias: null,
          effectiveAlias: null,
          source: 'test',
          workload: 'memory_extractor',
          modelEntry: null,
        },
        memoryDreaming: {
          configuredAlias: null,
          effectiveAlias: null,
          source: 'test',
          workload: 'memory_dreaming',
          modelEntry: null,
        },
        memoryConsolidation: {
          configuredAlias: null,
          effectiveAlias: null,
          source: 'test',
          workload: 'memory_consolidation',
          modelEntry: null,
        },
      },
    }),
    patchModelDefaults: () => ({ ok: true }),
    syncSettingsFromProjection: async () => undefined,
  };
}

async function isRecognizedByRuntime(method: string, pathname: string) {
  const req = request(method);
  const res = responseRecorder();
  const ctx = mockContext();
  const url = new URL(pathname, 'http://localhost');
  const handlers = [
    () => handleOpenApiRoutes(req, res, pathname),
    () => handleSystemRoutes(req, res, ctx, pathname),
    () => handleAgentRoutes(req, res, ctx, pathname),
    () => handleCapabilityCatalogRoutes(req, res, ctx, pathname),
    () => handleSessionRoutes(req, res, ctx, url, pathname),
    () => handleProviderConversationRoutes(req, res, ctx, url, pathname),
    () => handleMemoryRoutes(req, res, ctx, url, pathname),
    () => handleModelRoutes(req, res, ctx, pathname),
    () => handleJobRoutes(req, res, ctx, url, pathname),
    () => handleExternalIngressRoutes(req, res, ctx, pathname),
    () => handleRunRoutes(req, res, ctx, url, pathname),
    () => handleSettingsRoutes(req, res, ctx, pathname),
    () => handleSkillRoutes(req, res, ctx, url, pathname),
    () => handleMcpServerRoutes(req, res, ctx, url, pathname),
    () => handleWebhookRoutes(req, res, ctx, pathname),
  ];
  for (const handler of handlers) {
    if (await handler()) return true;
  }
  return false;
}

describe('control OpenAPI documentation', () => {
  it('keeps the OpenAPI route inventory in sync with the control API surface', () => {
    expect(documentedRoutes()).toEqual(expectedControlRoutes);
  });

  it('documents paths and methods that the runtime router recognizes', async () => {
    for (const route of documentedRoutes()) {
      const [method, pathname] = route.split(' ');
      await expect(
        isRecognizedByRuntime(method, samplePath(pathname)),
        route,
      ).resolves.toBe(true);
    }
  });

  it('documents the control API with security scopes and stable operation ids', () => {
    const spec = getGantryOpenApiDocument();

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Gantry Control API');
    expect(spec.paths['/v1/sessions/{sessionId}/messages']?.post).toMatchObject(
      {
        operationId: 'sendSessionMessage',
        'x-gantry-required-scopes': ['sessions:write'],
      },
    );
    expect(
      spec.paths['/v1/sessions/{sessionId}/messages']?.post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/SendSessionMessageRequest' });
    expect(
      spec.paths['/v1/jobs']?.post.responses['201'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/JobCreateResponse' });
    expect(spec.components.schemas.JobCreateRequest).toMatchObject({
      required: ['name', 'prompt', 'executionContext'],
    });
    expect(spec.components.schemas.Model).toMatchObject({
      properties: expect.objectContaining({
        responseFamily: { type: 'string', enum: ['anthropic', 'openai'] },
        executionProviderId: { type: 'string' },
        credentialProfileRef: { type: 'string' },
        modelRoute: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            id: { type: 'string', enum: ['anthropic', 'openrouter'] },
            label: { type: 'string' },
            metadata: { type: 'object', additionalProperties: true },
          }),
        }),
        capabilities: expect.objectContaining({ type: 'object' }),
        supportedWorkloads: expect.any(Object),
        cacheMode: { type: 'string' },
        cacheTokenFields: expect.any(Object),
      }),
    });
    expect(
      spec.paths['/v1/models/defaults']?.patch.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/ModelDefaultsPatchRequest' });
    expect(
      spec.components.schemas.ModelDefaultsPatchRequest.properties,
    ).not.toHaveProperty('providerPreset');
    expect(
      spec.components.schemas.ModelDefaultsPatchRequest.properties.memory,
    ).toMatchObject({
      oneOf: [
        { type: 'string', enum: ['reset', 'preset-managed'] },
        { type: 'null' },
      ],
    });
    expect(spec.paths['/v1/models/preview']?.post).toMatchObject({
      'x-gantry-required-scopes': ['sessions:read', 'jobs:read'],
    });
    expect(
      spec.paths['/v1/capabilities']?.get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CapabilityListResponse' });
    expect(
      spec.paths['/v1/capabilities/{capabilityId}']?.get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/CapabilityManifest' });
    expect(spec.components.schemas.AgentSources.properties.tools.items).toEqual(
      { $ref: '#/components/schemas/AgentToolSourceSelection' },
    );
    expect(
      spec.components.schemas.AgentSourceSelection.properties,
    ).not.toHaveProperty('kind');
    expect(
      spec.components.schemas.JobCreateRequest.properties.capabilityRequirements
        .items.properties.implementation.properties,
    ).toMatchObject({
      executableVersion: { type: 'string' },
      executableHash: { type: 'string' },
    });
    expect(
      spec.paths['/v1/agents']?.post.requestBody.content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/AgentCreateRequest' });
    expect(
      spec.paths['/v1/provider-connections']?.post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/ProviderConnectionRequest' });
    expect(spec.paths['/v1/ingresses/{ingressId}/invoke']?.post.security).toBe(
      undefined,
    );

    const operationIds = Object.values(spec.paths).flatMap((pathItem) =>
      Object.values(pathItem).map((operation) => operation.operationId),
    );
    expect(operationIds).toContain('listProviderConnections');
    expect(operationIds).toContain('createMcpServerDraft');
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('serves the OpenAPI JSON without requiring control API auth', async () => {
    const res = responseRecorder();

    const handled = await handleOpenApiRoutes(
      request('GET'),
      res,
      '/openapi.json',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    const spec = JSON.parse(res.body);
    expect(spec.paths['/v1/jobs/{jobId}/trigger'].post.operationId).toBe(
      'triggerJob',
    );
  });

  it('returns gone for the removed capability-catalog route', async () => {
    const res = responseRecorder();

    const handled = await handleCapabilityCatalogRoutes(
      request('GET'),
      res,
      mockContext(),
      '/v1/capability-catalog',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body)).toMatchObject({
      error: {
        code: 'GONE',
      },
    });
  });

  it('serves Swagger UI for interactive API exploration', async () => {
    const res = responseRecorder();

    const handled = await handleOpenApiRoutes(request('GET'), res, '/docs');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('SwaggerUIBundle');
    expect(res.body).toContain('/openapi.json');
  });
});

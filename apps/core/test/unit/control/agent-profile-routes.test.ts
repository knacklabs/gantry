import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/control/server/auth.js';
import type { Agent } from '@core/domain/agent/agent.js';

const agents = vi.hoisted(() => new Map<string, Agent>());
const fileArtifacts = vi.hoisted(() => ({
  seq: 0,
  writes: [] as Array<{ content: string }>,
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeFileArtifactStore: () => ({
    listFileArtifacts: async () => [],
    writeFileArtifact: async (input: { content: string }) => {
      fileArtifacts.writes.push(input);
      fileArtifacts.seq += 1;
      return {
        id: `artifact:${fileArtifacts.seq}`,
        appId: 'app:tenant',
        agentId: 'profile:main_agent',
        virtualScope: 'prompt-profile',
        virtualPath: 'main_agent/AGENTS.md',
        version: fileArtifacts.seq,
        storageType: 'local-filesystem',
        storageRef: `memory://${fileArtifacts.seq}`,
        contentHash: `hash-${fileArtifacts.seq}`,
        sizeBytes: Buffer.byteLength(input.content, 'utf8'),
        contentType: 'text/markdown',
        metadata: {},
        createdAt: '2026-06-03T00:00:00.000Z',
      };
    },
  }),
  getRuntimeStorage: () => ({
    repositories: {
      agents: {
        getAgent: async (agentId: string) => agents.get(agentId) ?? null,
      },
    },
    runtimeEvents: {
      publish: async () => undefined,
    },
  }),
}));

import { handleAgentRoutes } from '@core/control/server/routes/agents.js';
import { MAX_PROFILE_CONTENT_BYTES } from '@core/application/agents/agent-profile-service.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

describe('agent profile control routes', () => {
  it('accepts valid profile content even when JSON escaping exceeds the old body headroom', async () => {
    agents.set('agent:main_agent', {
      id: 'agent:main_agent' as never,
      appId: 'app:tenant' as never,
      name: 'Main Agent',
      status: 'active',
      createdAt: '2026-06-03T00:00:00.000Z' as never,
      updatedAt: '2026-06-03T00:00:00.000Z' as never,
    });
    fileArtifacts.seq = 0;
    fileArtifacts.writes = [];
    const content = '\\'.repeat(Math.floor(MAX_PROFILE_CONTENT_BYTES * 0.6));
    const raw = JSON.stringify({ content, expectedVersion: 0 });
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(
      MAX_PROFILE_CONTENT_BYTES + 64 * 1024,
    );
    const req = request('PUT', raw);
    const res = responseRecorder();

    await handleAgentRoutes(
      req,
      res,
      mockContext(),
      '/v1/agents/agent%3Amain_agent/profile-files/agents',
    );

    expect(res.statusCode).toBe(200);
    expect(fileArtifacts.writes).toHaveLength(1);
    expect(JSON.parse(res.body).content).toBe(content);
  });

  it('returns payload-too-large for multibyte content over the byte cap', async () => {
    agents.set('agent:main_agent', {
      id: 'agent:main_agent' as never,
      appId: 'app:tenant' as never,
      name: 'Main Agent',
      status: 'active',
      createdAt: '2026-06-03T00:00:00.000Z' as never,
      updatedAt: '2026-06-03T00:00:00.000Z' as never,
    });
    const content = 'é'.repeat(1_005_000);
    const raw = JSON.stringify({ content, expectedVersion: 0 });
    const req = request('PUT', raw);
    const res = responseRecorder();

    await handleAgentRoutes(
      req,
      res,
      mockContext(),
      '/v1/agents/agent%3Amain_agent/profile-files/agents',
    );

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      retryable: false,
    });
  });
});

function request(method: string, raw: string): IncomingMessage {
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw).toString(),
  };
  return req;
}

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

function mockContext(scopes: Scope[] = ['agents:admin']): ControlRouteContext {
  return {
    app: {} as ControlRouteContext['app'],
    runtimeHome: '/tmp/gantry-test',
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'app:tenant',
      },
    ],
    socketPath: '/tmp/gantry-control.sock',
    port: 8787,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
    triggerRateLimiter: { consume: () => true },
    getRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getRuntimeSettings']>,
    getInternalRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getInternalRuntimeSettings']>,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () =>
      ({ defaults: {} }) as ReturnType<ControlRouteContext['getModelDefaults']>,
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

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/control/server/auth.js';
import type { Agent } from '@core/domain/agent/agent.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
} from '@core/shared/agent-engine.js';

const agents = vi.hoisted(() => new Map<string, Agent>());
const saved = vi.hoisted(() => ({ value: null as Agent | null }));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      agents: {
        getAgent: async (agentId: string) => agents.get(agentId) ?? null,
        listAgents: async () => [...agents.values()],
        saveAgent: async (agent: Agent) => {
          saved.value = agent;
          agents.set(agent.id, agent);
        },
      },
      providerConnections: {
        listAgentConversationBindings: async () => [],
      },
    },
  }),
}));

import { handleAgentRoutes } from '@core/control/server/routes/agents.js';

type TestResponse = ServerResponse & {
  body: string;
  statusCode: number;
};

afterEach(() => {
  agents.clear();
  saved.value = null;
  vi.restoreAllMocks();
});

function seedAgent(): void {
  agents.set('agent:main_agent', {
    id: 'agent:main_agent' as never,
    appId: 'app:tenant' as never,
    name: 'Main Agent',
    status: 'active',
    createdAt: '2026-06-03T00:00:00.000Z' as never,
    updatedAt: '2026-06-03T00:00:00.000Z' as never,
  });
}

describe('agent engine control routes', () => {
  it('exposes the effective engine on the agent detail response', async () => {
    seedAgent();
    const res = responseRecorder();
    await handleAgentRoutes(
      request('GET'),
      res,
      mockContext({ engine: () => DEEPAGENTS_ENGINE }),
      '/v1/agents/agent%3Amain_agent',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agentEngine).toBe(DEEPAGENTS_ENGINE);
  });

  it('exposes the effective engine on the agent list response', async () => {
    seedAgent();
    const res = responseRecorder();
    await handleAgentRoutes(
      request('GET'),
      res,
      mockContext({ engine: () => DEFAULT_AGENT_ENGINE }),
      '/v1/agents',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agents[0].agentEngine).toBe(
      DEFAULT_AGENT_ENGINE,
    );
  });

  it('exposes the effective engine on the admin detail response', async () => {
    seedAgent();
    const res = responseRecorder();
    await handleAgentRoutes(
      request('GET'),
      res,
      mockContext({ engine: () => DEEPAGENTS_ENGINE }),
      '/v1/agents/agent%3Amain_agent/admin',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agent.agentEngine).toBe(DEEPAGENTS_ENGINE);
  });

  it('PATCH agentEngine routes through ctx.setAgentEngine (settings + reconcile)', async () => {
    seedAgent();
    const setAgentEngine = vi.fn(async () => undefined);
    const res = responseRecorder();
    await handleAgentRoutes(
      request('PATCH', JSON.stringify({ agentEngine: DEEPAGENTS_ENGINE })),
      res,
      mockContext({ engine: () => DEEPAGENTS_ENGINE, setAgentEngine }),
      '/v1/agents/agent%3Amain_agent',
    );
    expect(res.statusCode).toBe(200);
    expect(setAgentEngine).toHaveBeenCalledWith({
      appId: 'app:tenant',
      folder: 'main_agent',
      agentEngine: DEEPAGENTS_ENGINE,
    });
    expect(JSON.parse(res.body).agentEngine).toBe(DEEPAGENTS_ENGINE);
  });

  it('rejects PATCH with the locked pair copy when setAgentEngine throws', async () => {
    seedAgent();
    const setAgentEngine = vi.fn(async () => {
      throw new Error(
        'Model opus cannot run with DeepAgents. Choose one of: kimi-2.6.',
      );
    });
    const res = responseRecorder();
    await handleAgentRoutes(
      request('PATCH', JSON.stringify({ agentEngine: DEEPAGENTS_ENGINE })),
      res,
      mockContext({ engine: () => DEFAULT_AGENT_ENGINE, setAgentEngine }),
      '/v1/agents/agent%3Amain_agent',
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toBe(
      'Model opus cannot run with DeepAgents. Choose one of: kimi-2.6.',
    );
  });

  it('rejects an unsupported engine value at the contract boundary', async () => {
    seedAgent();
    const setAgentEngine = vi.fn();
    const res = responseRecorder();
    await handleAgentRoutes(
      request('PATCH', JSON.stringify({ agentEngine: 'langchain' })),
      res,
      mockContext({ engine: () => DEFAULT_AGENT_ENGINE, setAgentEngine }),
      '/v1/agents/agent%3Amain_agent',
    );
    expect(res.statusCode).toBe(400);
    expect(setAgentEngine).not.toHaveBeenCalled();
  });
});

function request(method: string, raw = ''): IncomingMessage {
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
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
    setHeader() {
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as TestResponse;
}

function mockContext(overrides: {
  engine: (folder?: string) => AgentEngine;
  setAgentEngine?: ControlRouteContext['setAgentEngine'];
  scopes?: Scope[];
}): ControlRouteContext {
  return {
    app: { loadState: async () => undefined } as ControlRouteContext['app'],
    runtimeHome: '/tmp/gantry-engine-route-test',
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(overrides.scopes ?? (['agents:admin'] as Scope[])),
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
    preflightModelPreset: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    getActiveModelCredentialProviderIds: async () => [],
    countPendingAccessRequests: async () => 0,
    listControlPlaneJobs: async () => [],
    syncSettingsFromProjection: async () => undefined,
    getEffectiveAgentEngine: overrides.engine,
    setAgentEngine: overrides.setAgentEngine ?? (async () => undefined),
  };
}

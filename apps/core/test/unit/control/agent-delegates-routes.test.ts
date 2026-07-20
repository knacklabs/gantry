import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import {
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';
import type { RuntimeSettings } from '@core/config/settings/runtime-settings-types.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Agent } from '@core/domain/agent/agent.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const state = vi.hoisted(() => ({
  agents: [] as Agent[],
  conversationRoutes: {} as Record<string, ReturnType<typeof liveRoute>>,
  delegationEnabled: true,
  latest: null as null | {
    appId: string;
    revision: number;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note: null;
    createdAt: string;
  },
}));

const writeControlDesiredState = vi.hoisted(() =>
  vi.fn(
    async (input: {
      res: ServerResponse;
      body: { settings: Record<string, unknown>; expectedRevision: number };
    }) => {
      const revision = (state.latest?.revision ?? 0) + 1;
      state.latest = {
        appId: 'app:tenant',
        revision,
        settingsDocument: input.body.settings,
        minReaderVersion: 14,
        createdBy: 'control-api:test',
        note: null,
        createdAt: '2026-07-18T00:00:00.000Z',
      };
      input.res.statusCode = 200;
      input.res.setHeader('content-type', 'application/json');
      input.res.end(JSON.stringify({ revision }));
      return true;
    },
  ),
);

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      agents: {
        getAgent: async (agentId: string) =>
          state.agents.find((agent) => agent.id === agentId) ?? null,
        listAgents: async () => state.agents,
      },
      settingsRevisions: {
        getLatestSettingsRevision: async () => state.latest,
      },
      tools: {
        listAgentToolBindings: async () =>
          state.delegationEnabled
            ? [{ status: 'active', toolId: 'tool:delegation' }]
            : [],
        getTool: async () => ({
          id: 'tool:delegation',
          appId: 'app:tenant',
          name: 'AgentDelegation',
        }),
      },
    },
  }),
}));

vi.mock('@core/control/server/routes/settings.js', () => ({
  writeControlDesiredState,
}));

import { handleAgentRoutes } from '@core/control/server/routes/agents.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

let fallbackSettings: RuntimeSettings;

beforeEach(() => {
  writeControlDesiredState.mockClear();
  state.delegationEnabled = true;
  fallbackSettings = configuredSettings();
  state.latest = {
    appId: 'app:tenant',
    revision: 7,
    settingsDocument: settingsToRevisionDocument(fallbackSettings),
    minReaderVersion: 14,
    createdBy: 'test',
    note: null,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
  state.agents = [
    agent('orchestrator', 'Orchestrator'),
    agent('researcher', 'Research Agent'),
    agent('offline', 'Offline Agent'),
    agent('unbound', 'Operations Agent'),
  ];
  state.conversationRoutes = {
    [makeAgentThreadQueueKey(
      'slack:C123',
      'agent:orchestrator',
      undefined,
      'slack_orchestrator',
    )]: liveRoute('agent:orchestrator', 'orchestrator', 'slack_orchestrator'),
    [makeAgentThreadQueueKey(
      'slack:C123',
      'agent:researcher',
      undefined,
      'slack_researcher',
    )]: liveRoute('agent:researcher', 'researcher', 'slack_researcher'),
  };
});

describe('agent delegates control routes', () => {
  it('requires agents:admin authentication for delegate routes', async () => {
    const noToken = await invoke('GET', undefined, { token: null });
    expect(noToken.statusCode).toBe(401);

    const wrongScope = await invoke('GET', undefined, {
      scopes: ['sessions:read'],
    });
    expect(wrongScope.statusCode).toBe(403);
  });

  it('GET returns persona and only the bound callable roster', async () => {
    const res = await invoke('GET');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      agentId: 'agent:orchestrator',
      revision: 7,
      delegates: ['researcher', 'offline', 'unbound', 'typo'],
    });
    expect(body.resolved).toEqual([
      expect.objectContaining({
        ref: 'researcher',
        agentId: 'agent:researcher',
        displayName: 'Research Agent',
        persona: 'research',
      }),
    ]);
    expect(body.resolved[0].toolName).toMatch(/^delegate_to_[A-Za-z0-9_-]+$/);
  });

  it('GET includes a thread-bound delegate for a whole-conversation orchestrator', async () => {
    const researcherRoute = Object.entries(state.conversationRoutes).find(
      ([, route]) => route.agentId === 'agent:researcher',
    )?.[1];
    state.conversationRoutes = {
      ...Object.fromEntries(
        Object.entries(state.conversationRoutes).filter(
          ([, route]) => route.agentId !== 'agent:researcher',
        ),
      ),
      [makeAgentThreadQueueKey(
        'slack:C123',
        'agent:researcher',
        'thread-42',
        'slack_researcher',
      )]: researcherRoute!,
    };

    expect(JSON.parse((await invoke('GET')).body).resolved).toEqual([
      expect.objectContaining({ agentId: 'agent:researcher' }),
    ]);
  });

  it('PUT round-trips through GET via the canonical desired-state writer', async () => {
    const put = await invoke('PUT', {
      delegates: ['agent:researcher'],
    });

    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body)).toEqual({ revision: 8 });
    expect(writeControlDesiredState).toHaveBeenCalledTimes(1);
    const write = writeControlDesiredState.mock.calls[0][0];
    expect(write.body.expectedRevision).toBe(7);
    expect(
      settingsFromRevisionDocument(write.body.settings).agents.orchestrator
        .delegates,
    ).toEqual(['researcher']);

    const get = await invoke('GET');
    expect(JSON.parse(get.body)).toMatchObject({
      revision: 8,
      delegates: ['researcher'],
      resolved: [
        {
          ref: 'researcher',
          agentId: 'agent:researcher',
          displayName: 'Research Agent',
          persona: 'research',
        },
      ],
    });
  });

  it('GET omits the callable roster without actual delegation authority', async () => {
    state.delegationEnabled = false;
    expect(JSON.parse((await invoke('GET')).body).resolved).toEqual([]);

    state.delegationEnabled = true;
    const locked = settingsFromRevisionDocument(state.latest!.settingsDocument);
    locked.agents.orchestrator.accessPreset = 'locked';
    state.latest!.settingsDocument = settingsToRevisionDocument(locked);
    expect(JSON.parse((await invoke('GET')).body).resolved).toEqual([]);
  });

  it('PUT rejects invalid delegate refs without writing desired state', async () => {
    for (const delegates of [
      ['missing'],
      ['orchestrator'],
      ['researcher', 'agent:researcher'],
      ['x'.repeat(161)],
    ]) {
      const res = await invoke('PUT', { delegates });
      expect(res.statusCode).toBe(400);
    }
    expect(writeControlDesiredState).not.toHaveBeenCalled();
    expect(state.latest?.revision).toBe(7);
  });

  it('PUT rejects delegate updates for an inactive orchestrator', async () => {
    state.agents[0] = { ...state.agents[0], status: 'disabled' };

    const res = await invoke('PUT', { delegates: ['researcher'] });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(writeControlDesiredState).not.toHaveBeenCalled();
  });

  it('does not seed another app from process settings without a revision', async () => {
    state.latest = null;

    expect(JSON.parse((await invoke('GET')).body)).toMatchObject({
      revision: 0,
      delegates: [],
      resolved: [],
    });
    const put = await invoke('PUT', { delegates: ['researcher'] });
    expect(put.statusCode).toBe(409);
    expect(JSON.parse(put.body)).toMatchObject({
      error: { code: 'SETTINGS_NOT_CONFIGURED' },
    });
    expect(writeControlDesiredState).not.toHaveBeenCalled();
  });
});

function configuredSettings(): RuntimeSettings {
  const settings = createDefaultRuntimeSettings();
  settings.agents = {
    orchestrator: configuredAgent('orchestrator', 'Orchestrator', 'developer', [
      'researcher',
      'offline',
      'unbound',
      'typo',
    ]),
    researcher: configuredAgent('researcher', 'Research Agent', 'research'),
    offline: configuredAgent('offline', 'Offline Agent', 'research'),
    unbound: configuredAgent('unbound', 'Operations Agent', 'operations'),
  };
  settings.providers.slack = { enabled: true };
  settings.providerAccounts.slack_orchestrator = {
    agentId: 'orchestrator',
    provider: 'slack',
    label: 'Orchestrator Slack',
    runtimeSecretRefs: {},
  };
  settings.providerAccounts.slack_researcher = {
    agentId: 'researcher',
    provider: 'slack',
    label: 'Researcher Slack',
    runtimeSecretRefs: {},
  };
  settings.providerAccounts.slack_unbound = {
    agentId: 'unbound',
    provider: 'slack',
    label: 'Unbound Slack',
    runtimeSecretRefs: {},
  };
  settings.providerAccounts.slack_offline = {
    agentId: 'offline',
    provider: 'slack',
    label: 'Offline Slack',
    runtimeSecretRefs: {},
    status: 'disabled',
  };
  settings.conversations.shared = {
    providerAccount: 'slack_orchestrator',
    externalId: 'slack:C123',
    kind: 'channel',
    displayName: 'Shared',
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: [],
    installedAgents: {
      orchestrator: configuredInstall('orchestrator', 'slack_orchestrator'),
      researcher: configuredInstall('researcher', 'slack_researcher'),
      offline: configuredInstall('offline', 'slack_offline'),
    },
  };
  settings.conversations.other = {
    providerAccount: 'slack_unbound',
    externalId: 'slack:C999',
    kind: 'channel',
    displayName: 'Other',
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: [],
    installedAgents: {
      unbound: configuredInstall('unbound', 'slack_unbound'),
    },
  };
  return settings;
}

function configuredAgent(
  folder: string,
  name: string,
  persona: 'developer' | 'research' | 'operations',
  delegates: string[] = [],
) {
  return {
    name,
    folder,
    runtime: 'worker' as const,
    persona,
    delegates,
    bindings: {},
    sources: { skills: [], mcpServers: [], tools: [] },
    capabilities: [],
    accessPreset: 'full' as const,
  };
}

function agent(folder: string, name: string): Agent {
  return {
    id: `agent:${folder}` as never,
    appId: 'app:tenant' as never,
    name,
    status: 'active',
    createdAt: '2026-07-18T00:00:00.000Z' as never,
    updatedAt: '2026-07-18T00:00:00.000Z' as never,
  };
}

function configuredInstall(agentId: string, providerAccountId: string) {
  return {
    agentId,
    providerAccountId,
    status: 'active' as const,
    memoryScope: 'conversation' as const,
    trigger: '@gantry',
    addedAt: '2026-07-18T00:00:00.000Z',
    requiresTrigger: true,
  };
}

async function invoke(
  method: 'GET' | 'PUT',
  body?: unknown,
  options: { token?: string | null; scopes?: string[] } = {},
) {
  const req = request(
    method,
    body,
    options.token === undefined ? 'test-token' : options.token,
  );
  const res = responseRecorder();
  await handleAgentRoutes(
    req,
    res,
    mockContext(options.scopes ?? ['agents:admin']),
    '/v1/agents/agent%3Aorchestrator/delegates',
  );
  return res;
}

function request(
  method: string,
  body: unknown,
  token: string | null,
): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(raw
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw).toString(),
        }
      : {}),
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

function mockContext(scopes: string[]): ControlRouteContext {
  return {
    app: {
      getConversationRoutes: () => state.conversationRoutes,
    } as ControlRouteContext['app'],
    runtimeHome: '/tmp/gantry-test',
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'app:tenant',
      },
    ],
    getInternalRuntimeSettings: () => fallbackSettings,
  } as ControlRouteContext;
}

function liveRoute(agentId: string, folder: string, providerAccountId: string) {
  return {
    name: folder,
    folder,
    agentId,
    providerAccountId,
    conversationId: 'shared',
    trigger: '@gantry',
    added_at: '2026-07-18T00:00:00.000Z',
  };
}

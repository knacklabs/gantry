import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTestControlServer } from '../harness/control-http-server.js';

const state = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  runs: new Map<string, any[]>(),
  listRunInputs: [] as any[],
}));

vi.mock('@core/config/index.js', () => ({
  MYCLAW_HOME: '/tmp/myclaw-session-control-runs-home',
  ONECLI_ALLOWED_ENV_KEYS: [],
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isSchedulerReady: vi.fn(() => true),
  runtimeJobSchedulePlanner: {
    createManualJobId: () => 'job-test',
    createJobId: () => 'job-test',
    planAppSchedule: () => ({
      scheduleType: 'manual',
      scheduleValue: 'manual',
      nextRun: null,
    }),
    planInitial: () => ({ nextRun: '2026-04-24T01:00:00.000Z' }),
    planResume: ({ job, clock }) =>
      job.next_run ??
      (job.schedule_type === 'manual'
        ? null
        : job.schedule_type === 'once'
          ? job.schedule_value
          : clock.now()),
  },
  requestSchedulerSync: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => ({
    listDueWebhookDeliveries: vi.fn(async () => []),
    claimDueWebhookDeliveries: vi.fn(async () => []),
    getAppSessionById: vi.fn(
      async (sessionId: string) => state.sessions.get(sessionId) ?? null,
    ),
  }),
  getRuntimeEventExchange: () => ({
    publish: vi.fn(async () => ({ eventId: 1 })),
    list: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({
      next: vi.fn(async () => []),
      close: vi.fn(),
    })),
  }),
  getRuntimeOpsRepository: () => ({
    storeChatMetadata: vi.fn(async () => undefined),
    storeMessage: vi.fn(async () => undefined),
  }),
  getRuntimeStorage: () => ({
    repositories: {
      agentSessions: {
        getAgentSession: vi.fn(
          async (sessionId: string) => state.sessions.get(sessionId) ?? null,
        ),
      },
      providerSessions: {
        getLatestProviderSession: vi.fn(async () => null),
      },
      agentRuns: {
        listAgentRunsBySession: vi.fn(async (input: any) => {
          state.listRunInputs.push(input);
          return (state.runs.get(input.sessionId) ?? []).slice(0, input.limit);
        }),
      },
      messages: {
        listRecentMessages: vi.fn(async () => []),
      },
    },
  }),
}));

async function readJson(response: Response): Promise<any> {
  return await response.json();
}

describe('session control runs integration', () => {
  beforeEach(() => {
    state.sessions.clear();
    state.runs.clear();
    state.listRunInputs.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists runs for an encoded session id through the control HTTP route', async () => {
    state.sessions.set('session:edge', {
      sessionId: 'session:edge',
      id: 'session:edge',
      appId: 'app-one',
      conversationId: 'conversation-edge',
      chatJid: 'app:app-one:conversation-edge',
      workspaceKey: 'app_scope_session_edge',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    state.runs.set('session:edge', [
      {
        id: 'run:latest',
        appId: 'app-one',
        agentSessionId: 'session:edge',
        status: 'completed',
      },
      {
        id: 'run:older',
        appId: 'app-one',
        agentSessionId: 'session:edge',
        status: 'completed',
      },
    ]);

    const server = await startTestControlServer({
      token: 'token-sessions',
      appId: 'app-one',
      scopes: ['sessions:read'],
    });

    try {
      const response = await fetch(
        `${server.baseUrl}/v1/sessions/${encodeURIComponent('session:edge')}/runs?limit=1`,
        {
          headers: { authorization: `Bearer ${server.token}` },
        },
      );
      const body = await readJson(response);

      expect(response.status).toBe(200);
      expect(body.runs.map((run: any) => run.id)).toEqual(['run:latest']);
      expect(state.listRunInputs).toEqual([
        { sessionId: 'session:edge', limit: 1 },
      ]);
    } finally {
      await server.close();
    }
  });

  it('checks app ownership before listing session runs', async () => {
    state.sessions.set('session:other-app', {
      sessionId: 'session:other-app',
      id: 'session:other-app',
      appId: 'app-two',
      conversationId: 'conversation-other',
      chatJid: 'app:app-two:conversation-other',
      workspaceKey: 'app_scope_session_other',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    state.runs.set('session:other-app', [
      {
        id: 'run:cross-app',
        appId: 'app-two',
        agentSessionId: 'session:other-app',
        status: 'completed',
      },
    ]);

    const server = await startTestControlServer({
      token: 'token-sessions',
      appId: 'app-one',
      scopes: ['sessions:read'],
    });

    try {
      const response = await fetch(
        `${server.baseUrl}/v1/sessions/${encodeURIComponent('session:other-app')}/runs`,
        {
          headers: { authorization: `Bearer ${server.token}` },
        },
      );
      const body = await readJson(response);

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(state.listRunInputs).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

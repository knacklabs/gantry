import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTestControlServer } from '../harness/control-http-server.js';

const state = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  ensureInputs: [] as any[],
  storedMessages: [] as any[],
  agents: new Map<string, any>(),
}));

vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-session-ensure-agent-home',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
  configureDesiredSettingsStorageProvider: vi.fn(() => undefined),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isJobTriggerQueueReady: vi.fn(() => true),
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
    ensureAppSession: vi.fn(async (input: any) => {
      state.ensureInputs.push(input);
      const sessionId = `session-${input.conversationId}`;
      const record = {
        sessionId,
        appId: input.appId,
        conversationId: input.conversationId,
        chatJid: input.chatJid,
        workspaceKey: input.workspaceFolder,
        title: input.title ?? null,
        defaultResponseMode: input.defaultResponseMode ?? 'sse',
        defaultWebhookId: input.defaultWebhookId ?? null,
      };
      state.sessions.set(sessionId, record);
      return record;
    }),
    getAppSessionById: vi.fn(
      async (sessionId: string) => state.sessions.get(sessionId) ?? null,
    ),
    getWebhookById: vi.fn(async () => undefined),
    upsertAppResponseRoute: vi.fn(async () => ({
      responseMode: 'sse',
      webhookId: null,
      correlationId: null,
    })),
  }),
  getRuntimeEventExchange: () => ({
    publish: vi.fn(async () => ({ eventId: 1 })),
    list: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({
      next: vi.fn(async () => []),
      close: vi.fn(),
    })),
  }),
  getRuntimeRepositories: () => ({
    storeChatMetadata: vi.fn(async () => undefined),
    storeMessage: vi.fn(async (message: any) => {
      state.storedMessages.push(message);
    }),
  }),
  getRuntimeStorage: () => ({
    repositories: {
      agents: {
        getAgent: vi.fn(
          async (agentId: string) => state.agents.get(agentId) ?? null,
        ),
      },
    },
  }),
}));

async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function makeRuntimeApp() {
  return {
    registerGroup: vi.fn(async () => undefined),
    queue: { enqueueMessageCheck: vi.fn() },
  };
}

async function startServer(runtimeApp: ReturnType<typeof makeRuntimeApp>) {
  return await startTestControlServer({
    token: 'token-session-ensure',
    appId: 'app-one',
    scopes: ['sessions:write', 'sessions:read'],
    runtimeApp,
    liveTurnsEnabled: false,
  });
}

describe('session ensure agent binding integration', () => {
  beforeEach(() => {
    state.sessions.clear();
    state.ensureInputs.length = 0;
    state.storedMessages.length = 0;
    state.agents.clear();
    state.agents.set('agent:folder-one', {
      id: 'agent:folder-one',
      appId: 'app-one',
      name: 'Agent One',
      status: 'active',
    });
    state.agents.set('agent:disabled-agent', {
      id: 'agent:disabled-agent',
      appId: 'app-one',
      name: 'Sleeper',
      status: 'disabled',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('binds the ensured session to the requested agent and admits messages on its queue', async () => {
    const runtimeApp = makeRuntimeApp();
    const server = await startServer(runtimeApp);

    try {
      const ensureResponse = await fetch(
        `${server.baseUrl}/v1/sessions/ensure`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${server.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            conversationId: 'conv-agent',
            agentId: 'agent:folder-one',
          }),
        },
      );
      const ensureBody = await readJson(ensureResponse);

      expect(ensureResponse.status).toBe(200);
      expect(ensureBody.chatJid).toBe('app:app-one:conv-agent');
      // Persisted session identity uses the agent's workspace folder, not a
      // synthetic app_<hash> folder.
      expect(state.ensureInputs).toEqual([
        expect.objectContaining({
          appId: 'app-one',
          conversationId: 'conv-agent',
          chatJid: 'app:app-one:conv-agent',
          workspaceFolder: 'folder-one',
        }),
      ]);
      expect(runtimeApp.registerGroup).toHaveBeenCalledWith(
        'app:app-one:conv-agent',
        expect.objectContaining({ folder: 'folder-one', name: 'Agent One' }),
      );

      const messageResponse = await fetch(
        `${server.baseUrl}/v1/sessions/${encodeURIComponent(ensureBody.sessionId)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${server.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ message: 'hello agent' }),
        },
      );
      const messageBody = await readJson(messageResponse);

      expect(messageResponse.status).toBe(202);
      expect(messageBody.accepted).toBe(true);
      expect(state.storedMessages).toEqual([
        expect.objectContaining({ chat_jid: 'app:app-one:conv-agent' }),
      ]);
      // The admitted queue key is the jid whose registered route carries the
      // agent's folder — the agent's queue, not a synthetic one.
      expect(runtimeApp.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'app:app-one:conv-agent',
      );
      const [registeredJid, registeredGroup] =
        runtimeApp.registerGroup.mock.calls[0];
      expect(registeredJid).toBe('app:app-one:conv-agent');
      expect(registeredGroup.folder).toBe('folder-one');
    } finally {
      await server.close();
    }
  });

  it('keeps the synthetic folder when agentId is omitted', async () => {
    const runtimeApp = makeRuntimeApp();
    const server = await startServer(runtimeApp);

    try {
      const response = await fetch(`${server.baseUrl}/v1/sessions/ensure`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${server.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ conversationId: 'conv-plain' }),
      });

      expect(response.status).toBe(200);
      expect(state.ensureInputs).toHaveLength(1);
      expect(state.ensureInputs[0].workspaceFolder).toMatch(
        /^app_[0-9a-f]{12}_app_one_conv_plain$/,
      );
      expect(runtimeApp.registerGroup).toHaveBeenCalledWith(
        'app:app-one:conv-plain',
        expect.objectContaining({
          folder: state.ensureInputs[0].workspaceFolder,
        }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects an unknown agentId with AGENT_NOT_FOUND and creates nothing', async () => {
    const runtimeApp = makeRuntimeApp();
    const server = await startServer(runtimeApp);

    try {
      const response = await fetch(`${server.baseUrl}/v1/sessions/ensure`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${server.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          conversationId: 'conv-x',
          agentId: 'agent:missing',
        }),
      });
      const body = await readJson(response);

      expect(response.status).toBe(404);
      expect(body.error.code).toBe('AGENT_NOT_FOUND');
      expect(body.error.message).toBe('Agent not found');
      expect(state.ensureInputs).toEqual([]);
      expect(runtimeApp.registerGroup).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects a disabled agent with a clear error', async () => {
    const runtimeApp = makeRuntimeApp();
    const server = await startServer(runtimeApp);

    try {
      const response = await fetch(`${server.baseUrl}/v1/sessions/ensure`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${server.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          conversationId: 'conv-y',
          agentId: 'agent:disabled-agent',
        }),
      });
      const body = await readJson(response);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe(
        'Agent is not active: agent:disabled-agent',
      );
      expect(state.ensureInputs).toEqual([]);
      expect(runtimeApp.registerGroup).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
}));

vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-control-test-home',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getSelectedAgentHarness: vi.fn(() => 'auto'),
  getDefaultModelConfig: configMocks.getDefaultModelConfig,
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
  configureDesiredSettingsStorageProvider: vi.fn(() => undefined),
}));

const schedulerMocks = vi.hoisted(() => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isSchedulerReady: vi.fn(() => true),
  requestSchedulerSync: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
  getBrowserStatus: vi.fn(async () => ({ hasState: true })),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: schedulerMocks.enqueueJobTrigger,
  isJobTriggerQueueReady: schedulerMocks.isSchedulerReady,
  isSchedulerReady: schedulerMocks.isSchedulerReady,
  schedulerNotReadyReason: () => undefined,
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
  requestSchedulerSync: schedulerMocks.requestSchedulerSync,
}));

const controlRepo = {
  listDueWebhookDeliveries: vi.fn(async () => []),
  claimDueWebhookDeliveries: vi.fn(async () => []),
  createJobTrigger: vi.fn(async () => ({
    triggerId: 'trigger-1',
    jobId: 'job-1',
    runId: null,
    requestedAt: '2026-04-24T00:00:00.000Z',
    requestedBy: 'sdk',
    status: 'pending',
    createdAt: '2026-04-24T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  })),
  getAppSessionByChatJid: vi.fn(async (chatJid: string) => ({
    sessionId: 'session-1',
    appId: 'app-one',
    conversationId: 'conv-1',
    chatJid,
    workspaceKey: 'app-folder',
    title: null,
    defaultResponseMode: 'sse',
    defaultWebhookId: null,
  })),
  getAppSessionById: vi.fn(async (sessionId: string) => ({
    sessionId,
    appId: sessionId === 'session-app-two' ? 'app-two' : 'app-one',
    conversationId: 'conv-1',
    chatJid: 'chat-1',
    workspaceKey: 'app-folder',
    title: null,
    defaultResponseMode: 'sse',
    defaultWebhookId: null,
  })),
  getAppSessionsByIds: vi.fn(async (sessionIds: string[]) =>
    sessionIds.map((sessionId) => ({
      sessionId,
      appId: sessionId === 'session-app-two' ? 'app-two' : 'app-one',
      conversationId: 'conv-1',
      chatJid: 'chat-1',
      workspaceKey: 'app-folder',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
  ),
  getAppSessionsByChatJids: vi.fn(async (chatJids: string[]) =>
    chatJids.map((chatJid) => ({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid,
      workspaceKey: 'app-folder',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
  ),
  getTriggerById: vi.fn(),
  markTriggerCompleted: vi.fn(async () => undefined),
};
const runtimeEvents = {
  publish: vi.fn(async () => ({ eventId: 1 })),
};

const opsRepo = {
  getJobById: vi.fn(),
  getJobRunById: vi.fn(),
  getAllConversationRoutes: vi.fn(async () => ({
    'chat-1': {
      name: 'App Folder',
      folder: 'app-folder',
      trigger: '@App',
      added_at: '2026-04-24T00:00:00.000Z',
      agentConfig: { persona: 'generalist' },
    },
  })),
  upsertJob: vi.fn(async (job) => ({ job, created: true })),
  listJobs: vi.fn(async () => []),
  listJobRuns: vi.fn(async () => []),
  listRecentJobEvents: vi.fn(async () => []),
  updateJob: vi.fn(async () => undefined),
};

let runtimeToolRepository: unknown;

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
  getRuntimeEventExchange: () => runtimeEvents,
  getRuntimeRepositories: () => opsRepo,
  getRuntimeStorage: () => ({
    repositories: {
      tools: runtimeToolRepository,
      mcpServers: undefined,
    },
  }),
}));

import { startControlServer } from '@core/control/server/index.js';

beforeEach(() => {
  configMocks.getDefaultModelConfig.mockImplementation(() => ({
    model: 'opus',
    source: 'system default',
  }));
  schedulerMocks.isSchedulerReady.mockReturnValue(true);
  schedulerMocks.enqueueJobTrigger.mockResolvedValue(undefined);
  schedulerMocks.requestSchedulerSync.mockClear();
  controlRepo.getAppSessionByChatJid.mockImplementation(async (chatJid) => ({
    sessionId: 'session-1',
    appId: 'app-one',
    conversationId: 'conv-1',
    chatJid,
    workspaceKey: 'app-folder',
    title: null,
    defaultResponseMode: 'sse',
    defaultWebhookId: null,
  }));
  controlRepo.getAppSessionsByChatJids.mockImplementation(async (chatJids) =>
    chatJids.map((chatJid) => ({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid,
      workspaceKey: 'app-folder',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
  );
  controlRepo.createJobTrigger.mockResolvedValue({
    triggerId: 'trigger-1',
    jobId: 'job-1',
    runId: null,
    requestedAt: '2026-04-24T00:00:00.000Z',
    requestedBy: 'sdk',
    status: 'pending',
    createdAt: '2026-04-24T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  });
  controlRepo.getTriggerById.mockResolvedValue(undefined);
  controlRepo.markTriggerCompleted.mockResolvedValue(undefined);
  controlRepo.getAppSessionById.mockImplementation(async (sessionId) => ({
    sessionId,
    appId: sessionId === 'session-app-two' ? 'app-two' : 'app-one',
    conversationId: 'conv-1',
    chatJid: 'chat-1',
    workspaceKey: 'app-folder',
    title: null,
    defaultResponseMode: 'sse',
    defaultWebhookId: null,
  }));
  controlRepo.getAppSessionsByIds.mockImplementation(async (sessionIds) =>
    sessionIds.map((sessionId) => ({
      sessionId,
      appId: sessionId === 'session-app-two' ? 'app-two' : 'app-one',
      conversationId: 'conv-1',
      chatJid: 'chat-1',
      workspaceKey: 'app-folder',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
  );
  runtimeEvents.publish.mockResolvedValue({ eventId: 1 });
  opsRepo.getJobById.mockReset();
  opsRepo.getJobRunById.mockReset();
  opsRepo.getAllConversationRoutes.mockResolvedValue({
    'chat-1': {
      name: 'App Folder',
      folder: 'app-folder',
      trigger: '@App',
      added_at: '2026-04-24T00:00:00.000Z',
      agentConfig: { persona: 'generalist' },
    },
  });
  opsRepo.upsertJob.mockClear();
  opsRepo.listJobs.mockResolvedValue([]);
  opsRepo.updateJob.mockResolvedValue(undefined);
  runtimeToolRepository = undefined;
  browserMocks.getBrowserStatus.mockResolvedValue({ hasState: true });
});

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve test port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function requestWithRetry(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + 3000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.headers || {}),
        },
      });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

afterEach(() => {
  delete process.env.GANTRY_CONTROL_PORT;
  delete process.env.GANTRY_CONTROL_API_KEYS_JSON;
  vi.clearAllMocks();
});

describe('control job trigger', () => {
  function makeJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      model: null,
      schedule_type: 'manual',
      schedule_value: 'manual',
      status: 'active',
      session_id: 'session-1',
      thread_id: null,
      execution_context: {
        conversationJid: 'chat-1',
        threadId: null,
        workspaceKey: 'app-folder',
        sessionId: 'session-1',
      },
      workspace_key: 'app-folder',
      created_by: 'human',
      created_at: '2026-04-24T00:00:00.000Z',
      updated_at: '2026-04-24T00:00:00.000Z',
      next_run: null,
      last_run: null,
      silent: false,
      cleanup_after_ms: 0,
      timeout_ms: 300000,
      max_retries: 0,
      retry_backoff_ms: 0,
      max_consecutive_failures: 3,
      consecutive_failures: 0,
      lease_run_id: null,
      lease_expires_at: null,
      pause_reason: null,
      ...overrides,
    };
  }

  function mockMutableJob(job: ReturnType<typeof makeJob>) {
    let current = job;
    opsRepo.getJobById.mockImplementation(async () => current);
    opsRepo.updateJob.mockImplementation(async (_id, updates) => {
      current = { ...current, ...updates };
    });
  }

  function exposeAgentTools(rules: string[]) {
    runtimeToolRepository = {
      listAgentToolBindings: vi.fn(async () =>
        rules.map((_rule, index) => ({
          status: 'active',
          toolId: `tool:${index}`,
        })),
      ),
      getTool: vi.fn(async (toolId: string) => {
        const index = Number(toolId.replace('tool:', ''));
        return { appId: 'app-one', name: rules[index] };
      }),
    };
  }

  it('previews why a stored job uses an inherited model', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        model: null,
        schedule_type: 'interval',
        schedule_value: '900',
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/preview`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'job', jobId: 'job-1' }),
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        target: 'job',
        jobId: 'job-1',
        kind: 'recurring',
        selection: {
          configuredAlias: null,
          effectiveAlias: 'opus',
          inherited: true,
          source: 'system default',
          workload: 'recurring_job',
          model: {
            displayName: 'Opus 4.8',
            responseFamily: 'anthropic',
            modelRoute: {
              id: 'anthropic',
              label: 'Anthropic',
              metadata: {
                providerModelId: 'claude-opus-4-8',
              },
            },
          },
        },
      });
      expect(body.why[0]).toContain('inherits system default');
    } finally {
      await handle.close();
    }
  });

  it('returns a forbidden preview response when the API key cannot access the stored job', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        session_id: 'session-app-two',
        execution_context: {
          conversationJid: 'chat-1',
          threadId: null,
          workspaceKey: 'app-folder',
          sessionId: 'session-app-two',
        },
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/preview`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'job', jobId: 'job-1' }),
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'API key cannot access this job',
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('creates jobs with an eagerly persisted default model preview', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'chat-1': {
            name: 'App Folder',
            folder: 'app-folder',
            trigger: '@App',
            requiresTrigger: false,
            conversationKind: 'channel',
            agentConfig: { persona: 'generalist' },
          },
        }),
      } as never,
      getBrowserStatus: browserMocks.getBrowserStatus,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Nightly',
            prompt: 'Summarize',
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        jobId: 'job-test',
        dryRun: false,
        modelAlias: 'opus',
        modelSource: 'system default',
        model: {
          displayName: 'Opus 4.8',
        },
        runtimeContext: {
          executionContext: {
            conversationJid: 'chat-1',
            workspaceKey: 'app-folder',
            threadId: null,
            sessionId: 'session-1',
          },
          notificationRoutes: [
            {
              conversationJid: 'chat-1',
              threadId: null,
              label: 'primary',
            },
          ],
          persona: 'generalist',
          browserProfileLabel: 'App Folder conversation browser',
          browserProfileName: expect.stringMatching(
            /^c-app-folder-[a-f0-9]{12}$/,
          ),
        },
      });
      expect(opsRepo.upsertJob).toHaveBeenCalledWith(
        expect.objectContaining({ model: null }),
      );
    } finally {
      await handle.close();
    }
  });

  it('uses the target agent scope for inherited create job model previews', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    configMocks.getDefaultModelConfig.mockImplementation(
      (_kind, agentFolder) =>
        agentFolder === 'app-folder'
          ? {
              model: 'sonnet',
              source: 'settings.yaml agents.<agent>.model',
            }
          : {
              model: 'opus',
              source: 'system default',
            },
    );
    const handle = startControlServer({
      app: {
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'chat-1': {
            name: 'App Folder',
            folder: 'app-folder',
            trigger: '@App',
            requiresTrigger: false,
            conversationKind: 'channel',
            agentConfig: { persona: 'generalist' },
          },
        }),
      } as never,
      getBrowserStatus: browserMocks.getBrowserStatus,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Scoped default',
            prompt: 'Summarize',
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        modelAlias: 'sonnet',
        modelSource: 'settings.yaml agents.<agent>.model',
        modelSelection: {
          alias: 'sonnet',
          source: 'settings.yaml agents.<agent>.model',
          explicit: false,
        },
        model: {
          displayName: 'Sonnet 4.6',
        },
      });
      expect(configMocks.getDefaultModelConfig).toHaveBeenCalledWith(
        'oneTimeJob',
        'app-folder',
      );
      expect(opsRepo.upsertJob).toHaveBeenCalledWith(
        expect.objectContaining({ model: null }),
      );
    } finally {
      await handle.close();
    }
  });

  it('creates required Browser jobs as active when Browser is selected for the agent', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    exposeAgentTools(['Browser']);
    const handle = startControlServer({
      app: {
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'chat-1': {
            name: 'App Folder',
            folder: 'app-folder',
            trigger: '@App',
            requiresTrigger: false,
            conversationKind: 'channel',
            agentConfig: { persona: 'generalist' },
          },
        }),
      } as never,
      getBrowserStatus: browserMocks.getBrowserStatus,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Browser Job',
            prompt: 'Open the site',
            accessRequirements: [
              { target: { kind: 'tool_rule', rule: 'Browser' } },
            ],
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      expect(browserMocks.getBrowserStatus).not.toHaveBeenCalled();
      expect(opsRepo.upsertJob).toHaveBeenCalledWith(
        expect.objectContaining({
          access_requirements: [
            { target: { kind: 'tool_rule', rule: 'Browser' } },
          ],
          status: 'active',
          setup_state: expect.objectContaining({ state: 'ready' }),
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('passes control API capability requirements into job creation', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'chat-1': {
            name: 'App Folder',
            folder: 'app-folder',
            trigger: '@App',
            requiresTrigger: false,
            conversationKind: 'channel',
            agentConfig: { persona: 'generalist' },
          },
        }),
      } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Lead Sync',
            prompt: 'Append leads to Acme Records',
            accessRequirements: [
              {
                target: {
                  kind: 'capability',
                  capabilityId: 'acme.records.append',
                  implementation: {
                    kind: 'local_cli',
                    name: 'acme',
                    executablePath: '/usr/local/bin/acme',
                    executableVersion: 'v0.9.0',
                    executableHash: 'sha256:abc123',
                    commandTemplate: '/usr/local/bin/acme records append *',
                  },
                },
                reason: 'Write lead rows after each run',
              },
            ],
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      expect(opsRepo.upsertJob).toHaveBeenCalledWith(
        expect.objectContaining({
          access_requirements: [
            expect.objectContaining({
              target: expect.objectContaining({
                kind: 'capability',
                capabilityId: 'acme.records.append',
                implementation: expect.objectContaining({ name: 'acme' }),
              }),
            }),
          ],
          status: 'paused',
          setup_state: expect.objectContaining({ state: 'missing_capability' }),
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('dry-runs job creation without returning a created job id', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'chat-1': {
            name: 'App Folder',
            folder: 'app-folder',
            trigger: '@App',
            requiresTrigger: false,
            conversationKind: 'channel',
            agentConfig: { persona: 'generalist' },
          },
        }),
      } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Preview',
            prompt: 'Preview only',
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
            modelAlias: 'haiku',
            dryRun: true,
          }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        dryRun: true,
        modelAlias: 'haiku',
        modelSource: 'explicit',
        runtimeContext: {
          executionContext: {
            conversationJid: 'chat-1',
            workspaceKey: 'app-folder',
            threadId: null,
            sessionId: 'session-1',
          },
        },
      });
      expect(body.jobId).toBeUndefined();
      expect(opsRepo.upsertJob).not.toHaveBeenCalled();
      expect(schedulerMocks.requestSchedulerSync).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('dry-runs required Browser jobs with setup blockers before persistence', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'chat-1': {
            name: 'App Folder',
            folder: 'app-folder',
            trigger: '@App',
            requiresTrigger: false,
            conversationKind: 'channel',
            agentConfig: { persona: 'generalist' },
          },
        }),
      } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Browser Preview',
            prompt: 'Preview browser work',
            accessRequirements: [
              { target: { kind: 'tool_rule', rule: 'Browser' } },
            ],
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
            dryRun: true,
          }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        dryRun: true,
        status: 'paused',
        setup: {
          state: 'missing_capability',
          blockers: [
            expect.objectContaining({
              requirementType: 'browser',
              requirementId: 'Browser',
              nextAction: expect.stringContaining('Browser'),
            }),
          ],
        },
      });
      expect(body.jobId).toBeUndefined();
      expect(opsRepo.upsertJob).not.toHaveBeenCalled();
      expect(schedulerMocks.requestSchedulerSync).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects raw model fields on job creation', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad',
            prompt: 'Nope',
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
            model: 'claude-opus-4-7',
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Unsupported job request field "model".',
        },
      });
      expect(opsRepo.upsertJob).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects job creation without executionContext.sessionId', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Nightly',
            prompt: 'Summarize',
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
            },
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: expect.stringContaining('executionContext.sessionId'),
        },
      });
      expect(opsRepo.upsertJob).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects unsupported model selector fields on job updates', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerModelId: 'moonshotai/kimi-k2.6',
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Unsupported job request field "providerModelId".',
        },
      });
      expect(opsRepo.updateJob).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('maps GET job application access errors to HTTP errors', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        session_id: 'session-app-two',
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    } finally {
      await handle.close();
    }
  });

  it('lists app-scoped job events through the job diagnostics route', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob({ session_id: 'session-1' }));
    opsRepo.listRecentJobEvents.mockResolvedValueOnce([
      {
        id: 7,
        job_id: 'job-1',
        run_id: 'run-1',
        event_type: 'job.tool_activity',
        payload: JSON.stringify({
          phase: 'tool_access_preflight',
          tool_access_requirements: ['Browser'],
          missing_tool_access_requirements: [],
          ok: true,
        }),
        created_at: '2026-04-24T00:00:00.000Z',
      },
    ]);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/events?run=run-1`,
        'token-jobs',
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        events: [
          {
            id: 7,
            event_type: 'job.tool_activity',
            run_id: 'run-1',
          },
        ],
      });
      expect(opsRepo.listRecentJobEvents).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          job_id: 'job-1',
          run_id: 'run-1',
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('updates jobs through the application use case', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Updated',
            prompt: 'New prompt',
            executionContext: {
              conversationJid: 'chat-1',
              threadId: 'thread-1',
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
            status: 'paused',
          }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jobId: 'job-1',
        name: 'Updated',
        prompt: 'New prompt',
        executionContext: {
          threadId: 'thread-1',
        },
        status: 'paused',
      });
      expect(opsRepo.updateJob).toHaveBeenCalledWith('job-1', {
        name: 'Updated',
        prompt: 'New prompt',
        execution_context: {
          conversationJid: 'chat-1',
          workspaceKey: 'app-folder',
          threadId: 'thread-1',
          sessionId: 'session-1',
        },
        thread_id: 'thread-1',
        status: 'paused',
        pause_reason: 'Paused by SDK',
        next_run: null,
      });
      expect(schedulerMocks.requestSchedulerSync).toHaveBeenCalledWith('job-1');
    } finally {
      await handle.close();
    }
  });

  it('passes control API capability requirements into job updates', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            accessRequirements: [
              {
                target: {
                  kind: 'capability',
                  capabilityId: 'acme.records.append',
                  implementation: {
                    kind: 'local_cli',
                    name: 'acme',
                    executablePath: '/usr/local/bin/acme',
                    executableVersion: 'v0.9.0',
                    executableHash: 'sha256:abc123',
                    commandTemplate: '/usr/local/bin/acme records append *',
                  },
                },
                reason: 'Write lead rows after each run',
              },
            ],
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(opsRepo.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          access_requirements: [
            expect.objectContaining({
              target: expect.objectContaining({
                kind: 'capability',
                capabilityId: 'acme.records.append',
                implementation: expect.objectContaining({ name: 'acme' }),
              }),
            }),
          ],
          status: 'paused',
          setup_state: expect.objectContaining({ state: 'missing_capability' }),
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects PATCH executionContext retargeting to another app session', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getAppSessionById.mockImplementation(async (sessionId) => ({
      sessionId,
      appId: sessionId === 'session-app-two' ? 'app-two' : 'app-one',
      conversationId: sessionId === 'session-app-two' ? 'conv-2' : 'conv-1',
      chatJid: sessionId === 'session-app-two' ? 'chat-2' : 'chat-1',
      workspaceKey:
        sessionId === 'session-app-two' ? 'other-folder' : 'app-folder',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    }));
    mockMutableJob(makeJob({ session_id: 'session-1' }));
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            executionContext: {
              conversationJid: 'chat-2',
              threadId: null,
              workspaceKey: 'other-folder',
              sessionId: 'session-app-two',
            },
          }),
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'FORBIDDEN',
        },
      });
      expect(opsRepo.updateJob).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects conflicting PATCH job model selectors', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            modelAlias: 'kimi',
            modelProfileId: 'openrouter:kimi-k2.6',
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Unsupported job request field "modelProfileId".',
        },
      });
      expect(opsRepo.updateJob).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('clears explicit job model selection through PATCH null alias', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob({ model: 'sonnet' }));
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelAlias: null }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.modelAlias).toBeNull();
      expect(opsRepo.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          model: null,
          pause_reason: null,
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('clears job thread binding through PATCH null threadId', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob({ thread_id: 'thread-1' }));
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            executionContext: {
              conversationJid: 'chat-1',
              threadId: null,
              workspaceKey: 'app-folder',
              sessionId: 'session-1',
            },
          }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.executionContext?.threadId).toBeNull();
      expect(opsRepo.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          execution_context: {
            conversationJid: 'chat-1',
            workspaceKey: 'app-folder',
            threadId: null,
            sessionId: 'session-1',
          },
          thread_id: null,
          pause_reason: null,
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('pauses jobs through the application use case', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/pause`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ paused: true });
      expect(opsRepo.updateJob).toHaveBeenCalledWith('job-1', {
        status: 'paused',
        pause_reason: 'Paused by SDK',
        next_run: null,
      });
      expect(schedulerMocks.requestSchedulerSync).toHaveBeenCalledWith('job-1');
    } finally {
      await handle.close();
    }
  });

  it('resumes jobs through the application use case', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(
      makeJob({
        schedule_type: 'once',
        schedule_value: '2026-05-01T00:00:00.000Z',
        status: 'paused',
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/resume`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ resumed: true });
      expect(opsRepo.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'active',
          pause_reason: null,
          next_run: '2026-05-01T00:00:00.000Z',
        }),
      );
      expect(schedulerMocks.requestSchedulerSync).toHaveBeenCalledWith('job-1');
    } finally {
      await handle.close();
    }
  });

  it('rejects paused recurring jobs before manual trigger enqueue', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    mockMutableJob(
      makeJob({
        schedule_type: 'interval',
        schedule_value: '900',
        status: 'paused',
        pause_reason: 'maintenance',
        next_run: null,
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'CONFLICT',
          message:
            'Cannot trigger job while status is paused; resume the job explicitly first.',
        },
      });
      expect(opsRepo.updateJob).not.toHaveBeenCalled();
      expect(schedulerMocks.requestSchedulerSync).not.toHaveBeenCalled();
      expect(schedulerMocks.enqueueJobTrigger).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects triggers before scheduler readiness without persisting trigger rows', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    schedulerMocks.isSchedulerReady.mockReturnValue(false);
    opsRepo.getJobById.mockResolvedValue(makeJob({ status: 'active' }));
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'SCHEDULER_NOT_READY' },
      });
      expect(controlRepo.createJobTrigger).not.toHaveBeenCalled();
      expect(schedulerMocks.enqueueJobTrigger).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('marks trigger failed when enqueue loses scheduler readiness after persistence', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    schedulerMocks.enqueueJobTrigger.mockRejectedValueOnce(
      new Error('scheduler unavailable'),
    );
    opsRepo.getJobById.mockResolvedValue(makeJob({ status: 'active' }));
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'SCHEDULER_NOT_READY' },
      });
      expect(controlRepo.createJobTrigger).toHaveBeenCalledTimes(1);
      expect(controlRepo.markTriggerCompleted).toHaveBeenCalledWith(
        'trigger-1',
        'failed',
      );
    } finally {
      await handle.close();
    }
  });

  it('enqueues a trigger without clobbering an active running lease', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(makeJob({ status: 'running' }));
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(202);
      expect(opsRepo.updateJob).not.toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'active' }),
      );
      expect(schedulerMocks.enqueueJobTrigger).toHaveBeenCalledWith(
        'job-1',
        'trigger-1',
      );
    } finally {
      await handle.close();
    }
  });

  it('triggers a legacy sessionless job through its canonical conversation session', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        session_id: null,
        execution_context: {
          conversationJid: 'chat-1',
          threadId: null,
          workspaceKey: 'app-folder',
          sessionId: null,
        },
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(202);
      expect(controlRepo.getAppSessionByChatJid).toHaveBeenCalledWith('chat-1');
      expect(controlRepo.createJobTrigger).toHaveBeenCalledWith({
        jobId: 'job-1',
        requestedBy: JSON.stringify({
          kind: 'sdk',
          appId: 'app-one',
          sessionId: 'session-1',
        }),
      });
      expect(schedulerMocks.enqueueJobTrigger).toHaveBeenCalledWith(
        'job-1',
        'trigger-1',
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects a sessionless job when its conversation belongs to another app', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getAppSessionByChatJid.mockResolvedValueOnce({
      sessionId: 'session-app-two',
      appId: 'app-two',
      conversationId: 'conv-2',
      chatJid: 'chat-2',
      workspaceKey: 'other-folder',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        session_id: null,
        execution_context: {
          conversationJid: 'chat-2',
          threadId: null,
          workspaceKey: 'other-folder',
          sessionId: null,
        },
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'API key cannot access this job session',
        },
      });
      expect(controlRepo.createJobTrigger).not.toHaveBeenCalled();
      expect(schedulerMocks.enqueueJobTrigger).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('lets the default runtime API key trigger a host-owned sessionless job without control session rows', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'default',
      },
    ]);
    controlRepo.getAppSessionByChatJid.mockResolvedValueOnce(undefined);
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        session_id: null,
        workspace_key: 'main_agent',
        execution_context: {
          conversationJid: 'tg:-1003986348737',
          threadId: null,
          workspaceKey: 'main_agent',
          sessionId: null,
        },
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
        'token-jobs',
        { method: 'POST' },
      );

      expect(response.status).toBe(202);
      expect(controlRepo.createJobTrigger).toHaveBeenCalledWith({
        jobId: 'job-1',
        requestedBy: JSON.stringify({
          kind: 'sdk',
          appId: 'default',
          sessionId: '',
        }),
      });
      expect(schedulerMocks.enqueueJobTrigger).toHaveBeenCalledWith(
        'job-1',
        'trigger-1',
      );
    } finally {
      await handle.close();
    }
  });

  it('preserves trigger rate-limit wire code', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      let response: Response = null as unknown as Response;
      for (let i = 0; i < 21; i += 1) {
        response = await requestWithRetry(
          `http://127.0.0.1:${port}/v1/jobs/job-1/trigger`,
          'token-jobs',
          { method: 'POST' },
        );
      }

      expect(response?.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'RATE_LIMITED' },
      });
    } finally {
      await handle.close();
    }
  });

  it('preserves missing trigger wire code', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/triggers/missing/wait`,
        'token-jobs',
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'TRIGGER_NOT_FOUND' },
      });
    } finally {
      await handle.close();
    }
  });

  it('filters mixed-app jobs from app-scoped job listing', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    opsRepo.listJobs.mockResolvedValue([
      makeJob({
        id: 'visible',
        schedule_type: 'once',
        schedule_value: '2000-01-01T00:00:00.000Z',
        next_run: '2000-01-01T00:00:00.000Z',
      }),
      makeJob({
        id: 'mixed',
        session_id: 'session-app-two',
      }),
    ]);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs`,
        'token-jobs',
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        jobs: [
          expect.objectContaining({
            jobId: 'visible',
            promptPreview: 'Run',
            staleness: 'missed_window',
            modelAlias: null,
            modelSelection: {
              alias: 'opus',
              source: 'system default',
              explicit: false,
            },
            model: expect.objectContaining({
              displayName: 'Opus 4.8',
            }),
            toolAccess: expect.objectContaining({
              inheritedAgentTools: [],
              effectiveAllowedTools: [],
              source: 'inherited target agent capabilities',
            }),
          }),
        ],
      });
      expect(body.jobs[0]).not.toHaveProperty('prompt');
      expect(body.jobs[0]).not.toHaveProperty('fullPrompt');
      expect(body.jobs[0]).not.toHaveProperty('inheritedTools');
      expect(body.jobs[0]).not.toHaveProperty('inheritedToolCount');
      expect(body.jobs[0]).not.toHaveProperty('linkedSessions');
      expect(body.jobs[0]).not.toHaveProperty('notificationTarget');
      expect(body.jobs[0]).not.toHaveProperty('threadId');
    } finally {
      await handle.close();
    }
  });

  it('returns full job visibility metadata on detail', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue(
      makeJob({
        schedule_type: 'once',
        schedule_value: '2000-01-01T00:00:00.000Z',
        next_run: '2000-01-01T00:00:00.000Z',
      }),
    );
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/jobs/job-1`,
        'token-jobs',
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        jobId: 'job-1',
        prompt: 'Run',
        fullPrompt: 'Run',
        staleness: 'missed_window',
        modelAlias: null,
        modelSelection: {
          alias: 'opus',
          source: 'system default',
          explicit: false,
        },
        model: expect.objectContaining({
          displayName: 'Opus 4.8',
        }),
        toolAccess: expect.objectContaining({
          inheritedAgentTools: [],
          effectiveAllowedTools: [],
          source: 'inherited target agent capabilities',
        }),
        recentRunErrors: [],
      });
      expect(body).not.toHaveProperty('inheritedTools');
      expect(body).not.toHaveProperty('inheritedToolCount');
      expect(body).not.toHaveProperty('linkedSessions');
      expect(body).not.toHaveProperty('notificationTarget');
      expect(body).not.toHaveProperty('threadId');
    } finally {
      await handle.close();
    }
  });

  it('preserves trigger wait timeout wire code', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getTriggerById.mockResolvedValue({
      triggerId: 'trigger-1',
      jobId: 'job-1',
      runId: null,
      status: 'pending',
    });
    opsRepo.getJobById.mockResolvedValue(makeJob());
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/triggers/trigger-1/wait?timeoutMs=1`,
        'token-jobs',
      );

      expect(response.status).toBe(408);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'WAIT_TIMEOUT' },
      });
    } finally {
      await handle.close();
    }
  });

  it('returns after a successful trigger wait response', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getTriggerById.mockResolvedValue({
      triggerId: 'trigger-1',
      jobId: 'job-1',
      runId: 'run-1',
      status: 'completed',
    });
    opsRepo.getJobById.mockResolvedValue(makeJob());
    opsRepo.getJobRunById.mockResolvedValue({
      run_id: 'run-1',
      job_id: 'job-1',
      scheduled_for: '2026-04-24T00:00:00.000Z',
      started_at: '2026-04-24T00:00:00.000Z',
      ended_at: '2026-04-24T00:00:01.000Z',
      status: 'completed',
      result_summary: 'done',
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/triggers/trigger-1/wait?timeoutMs=1000`,
        'token-jobs',
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        triggerId: 'trigger-1',
        runId: 'run-1',
        status: 'completed',
        resultSummary: 'done',
      });
    } finally {
      await handle.close();
    }
  });
});

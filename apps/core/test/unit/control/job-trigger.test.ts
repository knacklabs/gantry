import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/config/index.js', () => ({
  MYCLAW_HOME: '/tmp/myclaw-control-test-home',
}));

const schedulerMocks = vi.hoisted(() => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isSchedulerReady: vi.fn(() => true),
  requestSchedulerSync: vi.fn(),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: schedulerMocks.enqueueJobTrigger,
  isSchedulerReady: schedulerMocks.isSchedulerReady,
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
    groupFolder: 'app-folder',
    title: null,
    defaultResponseMode: 'sse',
    defaultWebhookId: null,
  })),
  addControlEvent: vi.fn(async () => ({ eventId: 1 })),
  markTriggerCompleted: vi.fn(async () => undefined),
};

const opsRepo = {
  getJobById: vi.fn(),
  updateJob: vi.fn(async () => undefined),
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
  getRuntimeOpsRepository: () => opsRepo,
}));

import { startControlServer } from '@core/control/server/index.js';

beforeEach(() => {
  schedulerMocks.isSchedulerReady.mockReturnValue(true);
  schedulerMocks.enqueueJobTrigger.mockResolvedValue(undefined);
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
  delete process.env.MYCLAW_CONTROL_PORT;
  delete process.env.MYCLAW_CONTROL_API_KEYS_JSON;
  vi.clearAllMocks();
});

describe('control job trigger', () => {
  function makeJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      model: null,
      script: null,
      schedule_type: 'manual',
      schedule_value: 'manual',
      status: 'active',
      linked_sessions: ['app:app-one:conv-1'],
      session_id: null,
      thread_id: null,
      group_scope: 'app-folder',
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
      execution_mode: 'parallel',
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

  it('updates jobs through the application use case', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
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
            executionMode: 'serialized',
            threadId: 'thread-1',
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
        executionMode: 'serialized',
        threadId: 'thread-1',
        status: 'paused',
      });
      expect(opsRepo.updateJob).toHaveBeenCalledWith('job-1', {
        name: 'Updated',
        prompt: 'New prompt',
        execution_mode: 'serialized',
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

  it('pauses jobs through the application use case', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
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
      await expect(response.json()).resolves.toEqual({ resumed: true });
      expect(opsRepo.updateJob).toHaveBeenCalledWith('job-1', {
        status: 'active',
        pause_reason: null,
        next_run: '2026-05-01T00:00:00.000Z',
      });
      expect(schedulerMocks.requestSchedulerSync).toHaveBeenCalledWith('job-1');
    } finally {
      await handle.close();
    }
  });

  it('resumes paused recurring jobs before manual trigger enqueue', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
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

      expect(response.status).toBe(202);
      expect(opsRepo.updateJob).toHaveBeenCalledWith('job-1', {
        status: 'active',
        pause_reason: null,
        next_run: expect.any(String),
      });
      expect(schedulerMocks.requestSchedulerSync).toHaveBeenCalledWith('job-1');
      expect(schedulerMocks.enqueueJobTrigger).toHaveBeenCalledWith(
        'job-1',
        'trigger-1',
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects triggers before scheduler readiness without persisting trigger rows', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    schedulerMocks.isSchedulerReady.mockReturnValue(false);
    opsRepo.getJobById.mockResolvedValue({
      id: 'job-1',
      linked_sessions: ['app:app-one:conv-1'],
      status: 'active',
    });
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
      expect(controlRepo.createJobTrigger).not.toHaveBeenCalled();
      expect(schedulerMocks.enqueueJobTrigger).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('marks trigger failed when enqueue loses scheduler readiness after persistence', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    opsRepo.getJobById.mockResolvedValue({
      id: 'job-1',
      linked_sessions: ['app:app-one:conv-1'],
      status: 'active',
    });
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
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-jobs',
        scopes: ['jobs:write'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobById.mockResolvedValue({
      id: 'job-1',
      linked_sessions: ['app:app-one:conv-1'],
      status: 'running',
    });
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
});

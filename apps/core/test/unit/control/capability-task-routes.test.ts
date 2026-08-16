import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleCapabilityTaskRoutes } from '@core/control/server/routes/capability-tasks.js';

const repository = {
  getTask: vi.fn(),
  transitionTask: vi.fn(),
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ repositories: { asyncTasks: repository } }),
}));

function request(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  return {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token' },
    on(event: string, listener: (value?: unknown) => void) {
      if (event === 'data') listener(Buffer.from(raw));
      if (event === 'end') listener();
      return this;
    },
    once: () => undefined,
  } as unknown as IncomingMessage;
}

function response() {
  return {
    statusCode: 0,
    body: '',
    setHeader() { return this; },
    end(chunk?: unknown) { this.body += chunk ? String(chunk) : ''; return this; },
  } as unknown as ServerResponse & { body: string };
}

function task(status: 'waiting_external' | 'completed' = 'waiting_external') {
  return {
    id: 'task-1', appId: 'default', agentId: 'agent-1', conversationId: 'conversation-1', threadId: null,
    parentRunId: 'run-1', parentJobId: 'job-1', parentJobRunId: null, kind: 'external_capability', status,
    admissionClass: 'task', authoritySnapshotJson: { capabilityId: 'evaluator' },
    privateCorrelationJson: {
      completionTokenHash: createHash('sha256').update('gantry:external-capability-completion:v1:token').digest('hex'),
      ...(status === 'completed' ? { completionId: 'completion-1' } : {}),
    },
    leaseToken: 'lease-1', fencingVersion: 1, createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z', summary: 'evaluate recipe',
  };
}

function context(overrides: { triggerJob?: () => Promise<{ triggerId: string }>; jobStatus?: 'paused' | 'running' } = {}) {
  const jobManagement = {
    getJob: vi.fn(async () => ({ job: {
      id: 'job-1', status: overrides.jobStatus ?? 'paused',
      pause_reason: overrides.jobStatus === 'running' ? null : 'Waiting for external capability task task-1.',
    } })),
    resumeJob: vi.fn(async () => ({ resumed: true, job: { id: 'job-1' } })),
    triggerJob: vi.fn(overrides.triggerJob ?? (async () => ({ triggerId: 'trigger-1' }))),
    pauseJob: vi.fn(async () => ({ paused: true })),
  };
  return {
    value: {
      jobManagement,
      keys: [{ kid: 'test', tokenHash: createHash('sha256').update('admin-token').digest(), scopes: new Set(['jobs:write']), appId: 'default' }],
    } as unknown as ControlRouteContext,
    jobManagement,
  };
}

describe('capability task continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.getTask.mockResolvedValue(task());
    repository.transitionTask.mockImplementation(async (input) => ({ ...task('completed'), ...input }));
  });

  it('starts a new run on the same durable job after completion', async () => {
    const ctx = context();
    const res = response();
    await handleCapabilityTaskRoutes(request({
      completionToken: 'token', completionId: 'completion-1', resultRef: 'result-1', summary: 'failed with repair guidance', result: {},
    }), res, ctx.value, '/v1/capability-tasks/task-1/complete');

    expect(ctx.jobManagement.resumeJob).toHaveBeenCalledWith({ appId: 'default', jobId: 'job-1' });
    expect(ctx.jobManagement.triggerJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }));
    expect(JSON.parse(res.body)).toMatchObject({ resumed: true, triggerId: 'trigger-1' });
  });

  it('re-pauses the same job when continuation enqueue fails', async () => {
    const ctx = context({ triggerJob: async () => { throw new Error('queue unavailable'); } });
    await expect(handleCapabilityTaskRoutes(request({
      completionToken: 'token', completionId: 'completion-1', resultRef: 'result-1', summary: 'done', result: {},
    }), response(), ctx.value, '/v1/capability-tasks/task-1/complete')).rejects.toThrow('queue unavailable');

    expect(ctx.jobManagement.pauseJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-1', reason: expect.stringContaining('task-1'),
    }));
  });

  it('does not overlap the original run when completion wins the suspension race', async () => {
    const ctx = context({ jobStatus: 'running' });
    const res = response();
    await handleCapabilityTaskRoutes(request({
      completionToken: 'token', completionId: 'completion-1', resultRef: 'result-1', summary: 'done', result: {},
    }), res, ctx.value, '/v1/capability-tasks/task-1/complete');

    expect(ctx.jobManagement.resumeJob).not.toHaveBeenCalled();
    expect(ctx.jobManagement.triggerJob).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ resumed: false, triggerId: null });
  });
});

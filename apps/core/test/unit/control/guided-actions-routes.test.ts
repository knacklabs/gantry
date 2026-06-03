import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleGuidedActionRoutes } from '@core/control/server/routes/guided-actions.js';

const resumeJob = vi.fn();

vi.mock('@core/control/server/routes/jobs.js', () => ({
  createJobManagementService: () => ({ resumeJob }),
}));

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

/**
 * Build a request whose body is delivered through the standard data/end events
 * so `readJson` resolves. Without emitting these the handler hangs forever.
 */
function jsonRequest(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const raw = JSON.stringify(body);
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    on(event: string, listener: (arg?: unknown) => void) {
      if (event === 'data') listener(Buffer.from(raw));
      if (event === 'end') listener();
      return this;
    },
    once: () => undefined,
  } as unknown as IncomingMessage;
}

function adminContext(
  scopes: Array<'agents:admin' | 'jobs:write' | 'sessions:read'> = [
    'agents:admin',
    'jobs:write',
  ],
): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('admin-token').digest(),
        scopes: new Set(scopes),
        appId: 'default',
      },
    ],
    getRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getRuntimeSettings']>,
    getInternalRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getInternalRuntimeSettings']>,
    getActiveModelCredentialProviderIds: async () => [],
    countPendingAccessRequests: async () => 0,
    listControlPlaneJobs: async () => [],
  } as unknown as ControlRouteContext;
}

const AUTH = { authorization: 'Bearer admin-token' };

describe('handleGuidedActionRoutes preview', () => {
  it('returns 200 with a GuidedActionPreview for a valid {action,label} body', async () => {
    const req = jsonRequest(
      'POST',
      { action: 'restart_runtime', label: 'Restart the runtime.' },
      AUTH,
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/preview',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      action: 'restart_runtime',
      label: 'Restart the runtime.',
      effect: 'Restarts the Gantry runtime.',
      requiresApproval: true,
      writesSettings: false,
      restartsRuntime: true,
    });
  });

  it('returns 400 INVALID_REQUEST when a valid action is missing a label', async () => {
    const req = jsonRequest('POST', { action: 'restart_runtime' }, AUTH);
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/preview',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('label is required');
  });

  it('returns 400 INVALID_REQUEST for an unknown action', async () => {
    const req = jsonRequest(
      'POST',
      { action: 'nope', label: 'whatever' },
      AUTH,
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/preview',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('Unknown guided action');
  });

  it('rejects a request without agents:admin scope', async () => {
    const ctx = {
      ...adminContext(),
      keys: [
        {
          kid: 'test',
          tokenHash: createHash('sha256').update('weak-token').digest(),
          scopes: new Set(['sessions:read' as const]),
          appId: 'default',
        },
      ],
    } as unknown as ControlRouteContext;
    const req = jsonRequest(
      'POST',
      { action: 'restart_runtime', label: 'Restart the runtime.' },
      { authorization: 'Bearer weak-token' },
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      ctx,
      '/v1/guided-actions/preview',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('agents:admin');
  });

  it('rejects a request with no auth header', async () => {
    const req = jsonRequest('POST', {
      action: 'restart_runtime',
      label: 'Restart the runtime.',
    });
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/preview',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });
});

describe('handleGuidedActionRoutes execute', () => {
  beforeEach(() => {
    resumeJob.mockReset();
  });

  it('runs resume_job server-side and returns a done receipt', async () => {
    resumeJob.mockResolvedValue({ resumed: true, job: { id: 'job_1' } });
    const req = jsonRequest(
      'POST',
      {
        action: 'resume_job',
        label: 'Resume the blocked job.',
        params: { jobId: 'job_1' },
      },
      AUTH,
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/execute',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(resumeJob).toHaveBeenCalledWith({
      jobId: 'job_1',
      appId: 'default',
    });
    const body = JSON.parse(res.body);
    expect(body.status).toBe('done');
    expect(body.changed).toContain('job_1');
  });

  it('requires jobs:write before running resume_job server-side', async () => {
    const req = jsonRequest(
      'POST',
      {
        action: 'resume_job',
        label: 'Resume the blocked job.',
        params: { jobId: 'job_1' },
      },
      AUTH,
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(['agents:admin']),
      '/v1/guided-actions/execute',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('jobs:write');
    expect(resumeJob).not.toHaveBeenCalled();
  });

  it('returns manual for resume_job with no jobId param', async () => {
    const req = jsonRequest(
      'POST',
      { action: 'resume_job', label: 'Resume the blocked job.' },
      AUTH,
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/execute',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(resumeJob).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      status: 'manual',
      instruction: 'Resume the blocked job.',
    });
  });

  it('returns manual for an action with no server-side executor', async () => {
    const req = jsonRequest(
      'POST',
      { action: 'connect_provider', label: 'Connect a provider.' },
      AUTH,
    );
    const res = responseRecorder();

    const handled = await handleGuidedActionRoutes(
      req,
      res,
      adminContext(),
      '/v1/guided-actions/execute',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'manual',
      instruction: 'Connect a provider.',
    });
  });
});

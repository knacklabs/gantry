import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('__drizzle_migrations')) {
      return { rows: [{ applied: 10_000 }] };
    }
    return { rows: [{ '?column?': 1 }] };
  }),
}));

const workerRepository = vi.hoisted(() => ({
  listWorkers: vi.fn(async () => []),
}));

const runtimeSettings = vi.hoisted(() => ({
  unavailable: false,
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ service: { pool } }),
  getWorkerCoordinationRepository: () => workerRepository,
}));

// system.ts reads runtime accessors (worker id, scheduler readiness, oldest
// waiting age, live capacity limit) from the injected ControlRouteContext, so
// no jobs/runtime-services module mocks are needed here — only the config and
// settings-load state used by the local settingsLoaded() helper.
vi.mock('@core/config/index.js', () => ({
  getRuntimeSettingsForConfig: () => {
    if (runtimeSettings.unavailable) {
      throw new Error('settings unavailable');
    }
    return { runtime: { queue: { maxMessageRuns: 3, maxJobRuns: 5 } } };
  },
  getControlEnvValue: (key: string) => process.env[key]?.trim() || '',
  GANTRY_HOME: '/tmp/gantry-system-routes-test-home',
}));

vi.mock('@core/runtime/settings-load-state.js', () => ({
  areSettingsLoaded: () => true,
}));

import { handleSystemRoutes } from '@core/control/server/routes/system.js';
import {
  markDraining,
  _resetDrainingStateForTest,
} from '@core/app/bootstrap/draining-state.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

function request(
  method: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.headers = headers;
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

const ctx = {
  processRole: 'all',
  liveExecution: true,
  roleReadinessRequirements: {
    requiresApiAuthConfigured: false,
    requiresWorkerRegistration: false,
    requiresSchedulerClaiming: false,
    requiresLiveCapacitySignal: false,
  },
  keys: [],
  port: 0,
  socketPath: '/tmp/control.sock',
  currentWorkerInstanceId: () => null,
  isSchedulerReady: () => true,
  oldestWaitingLiveAdmissionSeconds: () => 0,
  liveCapacityLimit: () => 3,
} as unknown as ControlRouteContext;

afterEach(() => {
  _resetDrainingStateForTest();
  workerRepository.listWorkers.mockReset().mockResolvedValue([]);
  runtimeSettings.unavailable = false;
});

describe('operational system routes', () => {
  it('serves /healthz unauthenticated with 200', async () => {
    const res = responseRecorder();
    const handled = await handleSystemRoutes(
      request('GET'),
      res,
      ctx,
      '/healthz',
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('returns 503 from /readyz while draining and names the failing check', async () => {
    markDraining();
    const res = responseRecorder();
    await handleSystemRoutes(request('GET'), res, ctx, '/readyz');
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('not_ready');
    expect(body.role).toBe('all');
    expect(body.checks.draining).toBe(true);
    expect(body.failing).toContain('draining');
  });

  it('serves /metrics as Prometheus text and exports gantry_up + role gauge', async () => {
    const res = responseRecorder();
    await handleSystemRoutes(request('GET'), res, ctx, '/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('gantry_up 1');
    expect(res.body).toContain('gantry_draining 0');
    expect(res.body).toContain('gantry_process_role{role="all"} 1');
  });

  it('serves authenticated runtime summary and sanitized instance inventory', async () => {
    const now = Date.now();
    workerRepository.listWorkers.mockResolvedValue([
      {
        id: 'current-1',
        processRole: 'all',
        status: 'healthy',
        heartbeatAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        createdAt: new Date(now - 60_000).toISOString(),
        capabilities: ['browser', 'local-cli:git'],
        bootNonce: 'secret-boot-nonce',
        imageDigest: 'sha256:secret-image',
        version: 'secret-version',
        transport: { port: 3939 },
        leaseToken: 'secret-lease',
        rawSettings: { secret: true },
        rawMetrics: { load: 1 },
      },
      {
        id: 'job-2',
        processRole: 'job-worker',
        status: 'healthy',
        heartbeatAt: new Date(now - 100_000).toISOString(),
        lastSeenAt: new Date(now - 100_000).toISOString(),
        createdAt: new Date(now - 120_000).toISOString(),
        capabilities: ['scheduled-jobs'],
        bootNonce: 'secret-job-boot-nonce',
        imageDigest: 'sha256:secret-job-image',
        version: null,
      },
      {
        id: 'old-control',
        processRole: 'control',
        status: 'stopped',
        heartbeatAt: new Date(now - 200_000).toISOString(),
        lastSeenAt: new Date(now - 200_000).toISOString(),
        createdAt: new Date(now - 300_000).toISOString(),
        capabilities: [],
        bootNonce: 'secret-old-control-nonce',
        imageDigest: null,
        version: null,
      },
      {
        id: 'all-2',
        processRole: 'all',
        status: 'healthy',
        heartbeatAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        createdAt: new Date(now - 60_000).toISOString(),
        capabilities: [],
        bootNonce: 'secret-all-nonce',
        imageDigest: null,
        version: null,
      },
    ]);
    markDraining();
    const authenticatedCtx = {
      ...ctx,
      currentWorkerInstanceId: () => 'current-1',
      keys: [
        {
          kid: 'test',
          tokenHash: createHash('sha256').update('test-token').digest(),
          scopes: new Set(['sessions:read' as const]),
          appId: 'default',
        },
      ],
    } as ControlRouteContext;
    const headers = { authorization: 'Bearer test-token' };

    const unauthorizedResponse = responseRecorder();
    await handleSystemRoutes(
      request('GET'),
      unauthorizedResponse,
      authenticatedCtx,
      '/v1/runtime',
    );
    expect(unauthorizedResponse.statusCode).toBe(401);
    expect(workerRepository.listWorkers).not.toHaveBeenCalled();

    const summaryResponse = responseRecorder();
    await handleSystemRoutes(
      request('GET', headers),
      summaryResponse,
      authenticatedCtx,
      '/v1/runtime',
    );
    expect(JSON.parse(summaryResponse.body)).toMatchObject({
      role: 'all',
      status: 'degraded',
      capacity: { liveLimit: 3, jobLimit: 5 },
      counts: {
        instances: 3,
        liveWorkers: 2,
        jobWorkers: 3,
        stale: 1,
      },
      readiness: {
        status: 'degraded',
        checks: { draining: true },
        failing: ['draining'],
      },
    });

    const instancesResponse = responseRecorder();
    await handleSystemRoutes(
      request('GET', headers),
      instancesResponse,
      authenticatedCtx,
      '/v1/runtime/instances',
    );
    const body = JSON.parse(instancesResponse.body);
    expect(body.instances).toHaveLength(3);
    expect(body.instances[0]).toEqual({
      id: 'current-1',
      role: 'all',
      status: 'healthy',
      heartbeat: { status: 'fresh', at: new Date(now).toISOString() },
      readiness: expect.objectContaining({ status: 'degraded' }),
      capacity: { liveLimit: 3, jobLimit: 5 },
      capabilities: ['browser', 'local-cli:git'],
      startedAt: new Date(now - 60_000).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
    });
    expect(body.instances[1]).toMatchObject({
      id: 'job-2',
      heartbeat: { status: 'stale' },
      readiness: null,
      capacity: null,
    });
    expect(body.instances[2]).toMatchObject({
      id: 'all-2',
      role: 'all',
      heartbeat: { status: 'fresh' },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /bootNonce|imageDigest|transport|lease|rawSettings|rawMetrics|secret-/,
    );

    workerRepository.listWorkers.mockResolvedValue([]);
    const controlResponse = responseRecorder();
    await handleSystemRoutes(
      request('GET', headers),
      controlResponse,
      {
        ...authenticatedCtx,
        processRole: 'control',
        currentWorkerInstanceId: () => null,
      },
      '/v1/runtime/instances',
    );
    expect(JSON.parse(controlResponse.body).instances).toEqual([
      expect.objectContaining({
        id: 'control:self',
        role: 'control',
        heartbeat: { status: 'not-applicable', at: null },
      }),
    ]);
  });

  it('keeps the runtime inventory readable when settings are unavailable', async () => {
    runtimeSettings.unavailable = true;
    const authenticatedCtx = {
      ...ctx,
      keys: [
        {
          kid: 'test',
          tokenHash: createHash('sha256').update('test-token').digest(),
          scopes: new Set(['sessions:read' as const]),
          appId: 'default',
        },
      ],
    } as ControlRouteContext;
    const res = responseRecorder();
    await handleSystemRoutes(
      request('GET', { authorization: 'Bearer test-token' }),
      res,
      authenticatedCtx,
      '/v1/runtime',
    );

    expect(JSON.parse(res.body)).toMatchObject({
      status: 'degraded',
      capacity: { liveLimit: 3, jobLimit: null },
      readiness: { failing: ['settings'] },
    });
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('__drizzle_migrations')) {
      return { rows: [{ applied: 10_000 }] };
    }
    return { rows: [{ '?column?': 1 }] };
  }),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ service: { pool } }),
}));

// system.ts reads runtime accessors (worker id, scheduler readiness, oldest
// waiting age, live capacity limit) from the injected ControlRouteContext, so
// no jobs/runtime-services module mocks are needed here — only the config and
// settings-load state used by the local settingsLoaded() helper.
vi.mock('@core/config/index.js', () => ({
  getRuntimeSettingsForConfig: () => ({
    runtime: { queue: { maxMessageRuns: 3 } },
  }),
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

function request(method: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.headers = {};
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
});

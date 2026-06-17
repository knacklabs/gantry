import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Scope } from '@core/control/server/auth.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleSystemRoutes } from '@core/control/server/routes/system.js';
import type { WorkerInventorySnapshot } from '@core/runtime/worker-inventory-snapshot.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

const WORKER_SNAPSHOT: WorkerInventorySnapshot = {
  instanceId: 'runtime:test',
  hostname: 'test-host',
  startedAt: '2026-06-17T00:00:00.000Z',
  lastHeartbeatAt: '2026-06-17T00:00:05.000Z',
  warmPool: {
    availableTarget: 2,
    genericAvailable: 1,
    genericStarting: 1,
    boundActive: 3,
    boundIdle: 0,
    boundDraining: 0,
    maxBoundWorkers: 4,
    cachePrewarm: {
      pending: 0,
      succeeded: 1,
      skipped: 0,
      failed: 0,
    },
    cacheShapes: [
      {
        cacheShapeKey: 'shape:test',
        status: 'succeeded',
        workers: 1,
      },
    ],
  },
  queue: {
    activeMessageRuns: 2,
    pendingConversationKeys: 5,
    maxMessageRuns: 3,
  },
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

function request(options: {
  method: string;
  authorization?: string | null;
}): IncomingMessage {
  return {
    method: options.method,
    headers:
      options.authorization === undefined
        ? { authorization: 'Bearer test-token' }
        : options.authorization === null
          ? {}
          : { authorization: options.authorization },
    on: () => undefined,
    once: () => undefined,
  } as unknown as IncomingMessage;
}

function mockContext(scopes: Scope[] = ['sessions:read']): ControlRouteContext {
  return {
    app: {
      getWorkerInventorySnapshot: () => WORKER_SNAPSHOT,
    } as unknown as ControlRouteContext['app'],
    runtimeHome: '/tmp/gantry-test',
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'default',
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
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () =>
      ({ defaults: {} }) as ReturnType<ControlRouteContext['getModelDefaults']>,
    patchModelDefaults: () => ({ ok: true }),
    preflightModelPreset: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    syncSettingsFromProjection: async () => undefined,
  };
}

describe('system control routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T00:00:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the local runtime worker inventory snapshot and healthy totals', async () => {
    const res = responseRecorder();

    const handled = await handleSystemRoutes(
      request({ method: 'GET' }),
      res,
      mockContext(),
      '/v1/runtime/workers',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      instances: [{ ...WORKER_SNAPSHOT, health: 'healthy' }],
      healthyTotals: {
        instances: 1,
        warmPool: WORKER_SNAPSHOT.warmPool,
        queue: WORKER_SNAPSHOT.queue,
      },
    });
  });

  it('returns persisted worker inventory snapshots for all runtime instances', async () => {
    const res = responseRecorder();
    const persisted: WorkerInventorySnapshot[] = [
      {
        ...WORKER_SNAPSHOT,
        instanceId: 'runtime:a',
        hostname: 'host-a',
        lastHeartbeatAt: '2026-06-17T00:00:05.000Z',
      },
      {
        ...WORKER_SNAPSHOT,
        instanceId: 'runtime:b',
        hostname: 'host-b',
        lastHeartbeatAt: '2026-06-16T23:58:00.000Z',
        warmPool: {
          ...WORKER_SNAPSHOT.warmPool,
          genericAvailable: 9,
        },
      },
    ];
    const ctx = {
      ...mockContext(),
      listWorkerInventorySnapshots: vi.fn(async () => persisted),
    } as ControlRouteContext & {
      listWorkerInventorySnapshots: () => Promise<WorkerInventorySnapshot[]>;
    };

    const handled = await handleSystemRoutes(
      request({ method: 'GET' }),
      res,
      ctx,
      '/v1/runtime/workers',
    );

    expect(handled).toBe(true);
    expect(ctx.listWorkerInventorySnapshots).toHaveBeenCalledWith({
      appId: 'default',
    });
    expect(JSON.parse(res.body)).toMatchObject({
      instances: [
        { instanceId: 'runtime:a', health: 'healthy' },
        { instanceId: 'runtime:b', health: 'stale' },
      ],
      healthyTotals: {
        instances: 1,
        warmPool: WORKER_SNAPSHOT.warmPool,
        queue: WORKER_SNAPSHOT.queue,
      },
    });
  });

  it('requires sessions:read to inspect runtime workers', async () => {
    const res = responseRecorder();

    await handleSystemRoutes(
      request({ method: 'GET' }),
      res,
      mockContext([]),
      '/v1/runtime/workers',
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe(
      'API key is missing required scope sessions:read',
    );
  });
});

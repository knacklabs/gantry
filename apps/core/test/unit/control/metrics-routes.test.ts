import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleMetricsRoutes } from '@core/control/server/routes/metrics.js';

const mocks = vi.hoisted(() => ({ queryConsoleMetrics: vi.fn() }));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      runtimeEvents: { queryConsoleMetrics: mocks.queryConsoleMetrics },
    },
  }),
}));

type TestResponse = ServerResponse & { body: string };

function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    setHeader: () => undefined,
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as TestResponse;
}

function context(): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'metrics-key',
        appId: 'app-one',
        scopes: new Set(['usage:read']),
        tokenHash: createHash('sha256').update('test-token').digest(),
      },
    ],
  } as unknown as ControlRouteContext;
}

async function handle(query = '') {
  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  } as IncomingMessage;
  const res = responseRecorder();
  const url = new URL(`/v1/metrics${query}`, 'http://localhost');
  await handleMetricsRoutes(req, res, context(), url, url.pathname);
  return res;
}

describe('metrics routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:34:56.000Z'));
    mocks.queryConsoleMetrics.mockReset().mockResolvedValue({
      usage: {
        totals: { requestCount: 0, inputTokens: 0, outputTokens: 0 },
        buckets: [],
        models: [],
      },
      runs: { total: 0, statuses: [] },
    });
  });

  afterEach(() => vi.useRealTimers());

  it('accepts only fixed console metric ranges', async () => {
    for (const [query, range, from, bucket] of [
      ['', '24h', '2026-08-11T12:34:56.000Z', 'hour'],
      ['?range=7d', '7d', '2026-08-05T12:34:56.000Z', 'day'],
      ['?range=30d', '30d', '2026-07-13T12:34:56.000Z', 'day'],
    ] as const) {
      const res = await handle(query);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ range, bucket });
      expect(mocks.queryConsoleMetrics).toHaveBeenLastCalledWith({
        appId: 'app-one',
        from,
        to: '2026-08-12T12:34:56.000Z',
        bucket,
      });
    }

    for (const query of [
      '?range=1h',
      '?from=2026-08-01T00:00:00Z',
      '?bucket=minute',
      '?range=24h&range=7d',
    ]) {
      const res = await handle(query);
      expect(res.statusCode).toBe(400);
    }
    expect(mocks.queryConsoleMetrics).toHaveBeenCalledTimes(3);
  });
});

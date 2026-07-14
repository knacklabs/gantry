import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleUsageRoutes } from '@core/control/server/routes/usage.js';

const mocks = vi.hoisted(() => ({ queryUsage: vi.fn() }));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: { runtimeEvents: { queryUsage: mocks.queryUsage } },
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

function request(): IncomingMessage {
  return {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  } as IncomingMessage;
}

function context(scopes: string[] = ['usage:read']): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'usage-key',
        appId: 'app-one',
        scopes: new Set(scopes),
        tokenHash: createHash('sha256').update('test-token').digest(),
      },
    ],
  } as unknown as ControlRouteContext;
}

async function handle(query: string, scopes?: string[]) {
  const res = responseRecorder();
  const url = new URL(`/v1/usage${query}`, 'http://localhost');
  const handled = await handleUsageRoutes(
    request(),
    res,
    context(scopes),
    url,
    url.pathname,
  );
  return { handled, res };
}

describe('usage routes', () => {
  beforeEach(() => {
    mocks.queryUsage.mockReset();
    mocks.queryUsage.mockResolvedValue([
      { requestCount: 1, inputTokens: 10, outputTokens: 5 },
    ]);
  });

  it.each([
    ['', 'required'],
    ['?from=nope&to=2026-07-02T00:00:00Z', 'required'],
    ['?from=2026-07-01T00:00:00Z&to=nope', 'required'],
    ['?from=2026-07-02T00:00:00Z&to=2026-07-01T00:00:00Z', 'before'],
  ])('rejects an invalid time range: %s', async (query, message) => {
    const { res } = await handle(query);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(message);
    expect(mocks.queryUsage).not.toHaveBeenCalled();
  });

  it('forwards every filter and scopes the query to the API key app', async () => {
    const { res } = await handle(
      '?from=2026-07-01T05:30:00%2B05:30&to=2026-07-02T05:30:00%2B05:30' +
        '&agentId=agent-one&apiKeyId=key-one&runId=run-one&jobId=job-one' +
        '&model=opus&appId=app-two',
    );

    expect(res.statusCode).toBe(200);
    expect(mocks.queryUsage).toHaveBeenCalledWith({
      appId: 'app-one',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
      agentId: 'agent-one',
      apiKeyId: 'key-one',
      runId: 'run-one',
      jobId: 'job-one',
      model: 'opus',
      groupBy: undefined,
    });
    expect(JSON.parse(res.body)).toEqual({
      usage: [{ requestCount: 1, inputTokens: 10, outputTokens: 5 }],
    });
  });

  it.each(['agent', 'api_key', 'model', 'day'] as const)(
    'forwards group_by=%s',
    async (groupBy) => {
      await handle(
        `?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z&group_by=${groupBy}`,
      );

      expect(mocks.queryUsage).toHaveBeenCalledWith(
        expect.objectContaining({ groupBy }),
      );
    },
  );

  it('rejects an unsupported group_by', async () => {
    const { res } = await handle(
      '?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z&group_by=provider',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('group_by');
    expect(mocks.queryUsage).not.toHaveBeenCalled();
  });

  it('returns 403 without usage:read', async () => {
    const { res } = await handle(
      '?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z',
      ['sessions:read'],
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('usage:read');
    expect(mocks.queryUsage).not.toHaveBeenCalled();
  });
});

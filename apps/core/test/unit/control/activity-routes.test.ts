import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleActivityRoutes } from '@core/control/server/routes/activity.js';

const mocks = vi.hoisted(() => ({
  countTasksByStatus: vi.fn(),
  getAgentRunForApp: vi.fn(),
  listEvents: vi.fn(),
  listRecentAgentRuns: vi.fn(),
  listTasks: vi.fn(),
  nextEvents: vi.fn(),
  closeSubscription: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      agentRuns: {
        getAgentRunForApp: mocks.getAgentRunForApp,
        listRecentAgentRuns: mocks.listRecentAgentRuns,
      },
      asyncTasks: {
        countTasksByStatus: mocks.countTasksByStatus,
        listTasks: mocks.listTasks,
      },
    },
    runtimeEvents: {
      list: mocks.listEvents,
      subscribe: mocks.subscribe,
    },
  }),
}));

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

function request(accept = 'application/json'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = 'GET';
  req.headers = {
    authorization: 'Bearer test-token',
    accept,
  };
  Object.defineProperty(req, 'destroyed', { value: false, writable: true });
  return req;
}

function responseRecorder(): TestResponse {
  const res = new EventEmitter() as TestResponse;
  res.statusCode = 0;
  res.body = '';
  res.headers = {};
  Object.defineProperty(res, 'destroyed', { value: false, writable: true });
  Object.defineProperty(res, 'writableEnded', {
    value: false,
    writable: true,
  });
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
    return res;
  };
  res.flushHeaders = vi.fn();
  res.write = ((chunk: unknown) => {
    res.body += String(chunk);
    return true;
  }) as TestResponse['write'];
  res.end = ((chunk?: unknown) => {
    if (chunk !== undefined) res.body += String(chunk);
    res.writableEnded = true;
    return res;
  }) as TestResponse['end'];
  return res;
}

function context(): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'activity-key',
        appId: 'app-one',
        scopes: new Set(['sessions:read']),
        tokenHash: createHash('sha256').update('test-token').digest(),
      },
    ],
    maxConcurrentStreams: 1,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
  } as unknown as ControlRouteContext;
}

const run = {
  id: 'agent-run:owned',
  appId: 'app-one',
  agentId: 'agent:owner',
  configVersionId: 'config:private',
  sessionId: 'session:private',
  conversationId: 'conversation:private',
  messageId: 'message:private',
  llmProfileId: 'llm:private',
  executionProviderId: 'provider:private',
  providerRunId: 'provider-run:private',
  providerSessionId: 'provider-session:private',
  workerId: 'worker:private',
  leaseOwner: 'lease:private',
  permissionDecisionIds: ['permission:private'],
  cause: 'message',
  status: 'running',
  createdAt: '2026-08-12T10:00:00.000Z',
  startedAt: '2026-08-12T10:00:01.000Z',
  resultSummary: 'Safe result',
};

function task(
  id: string,
  createdAt: string,
  privateCorrelationJson: Record<string, unknown>,
) {
  return {
    id,
    appId: 'app-one',
    agentId: `agent:${id}`,
    conversationId: 'conversation:private',
    parentRunId: run.id,
    kind: 'delegated_agent',
    status: 'running',
    admissionClass: 'task',
    authoritySnapshotJson: { secret: 'authority-private' },
    privateCorrelationJson,
    leaseToken: 'lease-token-private',
    fencingVersion: 7,
    createdAt,
    updatedAt: createdAt,
    summary: `Summary ${id}`,
  };
}

async function handle(path: string, accept?: string, ctx = context()) {
  const req = request(accept);
  const res = responseRecorder();
  const url = new URL(path, 'http://localhost');
  const handled = await handleActivityRoutes(req, res, ctx, url, url.pathname);
  return { req, res, ctx, handled };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentRunForApp.mockResolvedValue(run);
  mocks.listRecentAgentRuns.mockResolvedValue([run]);
  mocks.listTasks.mockResolvedValue([]);
  mocks.countTasksByStatus.mockResolvedValue([]);
  mocks.listEvents.mockResolvedValue([]);
  mocks.nextEvents.mockReturnValue(new Promise(() => undefined));
  mocks.subscribe.mockReturnValue({
    next: mocks.nextEvents,
    close: mocks.closeSubscription,
  });
});

it('lists agent-scoped activity in newest order', async () => {
  mocks.listRecentAgentRuns.mockResolvedValue([
    { ...run, id: 'agent-run:newest' },
    { ...run, id: 'agent-run:older' },
  ]);
  const { res } = await handle('/v1/activity?agentId=agent%3Aowner&limit=20');

  expect(res.statusCode).toBe(200);
  expect(mocks.listRecentAgentRuns).toHaveBeenCalledWith({
    appId: 'app-one',
    agentId: 'agent:owner',
    limit: 20,
  });
  expect(JSON.parse(res.body).runs.map(({ id }: { id: string }) => id)).toEqual([
    'agent-run:newest',
    'agent-run:older',
  ]);
});

describe('activity routes', () => {

  it('keeps the activity list app-scoped, bounded, and safe', async () => {
    mocks.listRecentAgentRuns.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        ...run,
        id: `agent-run:${index}`,
      })),
    );

    const { res } = await handle('/v1/activity');
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(mocks.listRecentAgentRuns).toHaveBeenCalledWith({
      appId: 'app-one',
      limit: 50,
    });
    expect(body.runs).toHaveLength(50);
    expect(res.body).not.toMatch(
      /private|conversationId|sessionId|permissionDecision|workerId/i,
    );
  });

  it.each([
    '/v1/activity?unknown=value',
    '/v1/activity?agentId=agent%3Aowner&agentId=agent%3Aother',
    '/v1/activity?agentId=',
    '/v1/activity?agentId=%20agent%3Aowner',
    '/v1/activity?limit=0',
    '/v1/activity?limit=51',
    '/v1/activity?limit=01',
    '/v1/activity?limit=1.5',
    '/v1/activity?limit=2&limit=3',
  ])('rejects invalid activity list query %s', async (path) => {
    const { res } = await handle(path);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(mocks.listRecentAgentRuns).not.toHaveBeenCalled();
  });

  it('returns bounded safe activity detail for an owned run', async () => {
    mocks.listTasks.mockResolvedValue([
      task('child', '2026-08-12T10:00:03.000Z', {
        parentTaskId: 'parent',
        targetAgentId: ' agent:target ',
        progress: {
          phase: 'working',
          lastProgress: 'Halfway',
          lastToolSummary: 'Read records',
          blocker: 'Waiting',
          stdoutTail: 'private stdout',
        },
        secret: 'private correlation',
      }),
      task('orphan', '2026-08-12T10:00:02.000Z', {
        parentTaskId: 'missing',
      }),
      task('parent', '2026-08-12T10:00:01.000Z', {}),
    ]);
    mocks.countTasksByStatus.mockResolvedValue([
      { status: 'running', count: 100 },
      { status: 'completed', count: 1 },
    ]);

    const { res } = await handle('/v1/activity/agent-run%3Aowned');
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(mocks.getAgentRunForApp).toHaveBeenCalledWith({
      appId: 'app-one',
      runId: 'agent-run:owned',
    });
    expect(mocks.listTasks).toHaveBeenCalledWith({
      appId: 'app-one',
      parentRunId: 'agent-run:owned',
      limit: 100,
      order: 'created_oldest_first',
    });
    expect(body).toMatchObject({ taskTotal: 101, truncated: true });
    expect(body.run).toEqual(
      expect.objectContaining({
        id: 'agent-run:owned',
        agentId: 'agent:owner',
        status: 'running',
        resultSummary: 'Safe result',
      }),
    );
    expect(body.tasks.map((item: { id: string }) => item.id)).toEqual([
      'parent',
      'orphan',
    ]);
    expect(body.tasks[0].children[0]).toEqual(
      expect.objectContaining({
        id: 'child',
        targetAgentId: 'agent:target',
        currentPhase: 'working',
        lastProgress: 'Halfway',
        lastToolSummary: 'Read records',
        blocker: 'Waiting',
      }),
    );
    expect(res.body).not.toMatch(
      /private|conversationId|sessionId|leaseToken|authoritySnapshot|stdout/i,
    );
  });

  it('returns 404 before reading tasks or events for a missing or cross-app run', async () => {
    mocks.getAgentRunForApp.mockResolvedValue(null);

    const detail = await handle('/v1/activity/cross-app');
    const events = await handle('/v1/activity/cross-app/events');

    expect(detail.res.statusCode).toBe(404);
    expect(events.res.statusCode).toBe(404);
    expect(mocks.listTasks).not.toHaveBeenCalled();
    expect(mocks.countTasksByStatus).not.toHaveBeenCalled();
    expect(mocks.listEvents).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('rejects malformed percent-encoding without throwing', async () => {
    const result = await handle('/v1/activity/%');

    expect(result.handled).toBe(false);
    expect(mocks.getAgentRunForApp).not.toHaveBeenCalled();
  });

  it('replays only safe cursor invalidations and cleans up the capped stream', async () => {
    mocks.listEvents.mockResolvedValue([
      {
        eventId: 8,
        appId: 'app-one',
        runId: run.id,
        eventType: 'task.progress',
        actor: 'runtime',
        correlationId: 'private-correlation',
        payload: { prompt: 'private prompt' },
        createdAt: '2026-08-12T10:00:08.000Z',
      },
    ]);
    const ctx = context();
    const { req, res } = await handle(
      '/v1/activity/agent-run%3Aowned/events?afterEventId=4',
      'text/event-stream',
      ctx,
    );

    expect(res.statusCode).toBe(200);
    expect(ctx.state.activeStreams).toBe(1);
    expect(mocks.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        runId: 'agent-run:owned',
        afterEventId: 4,
        limit: 100,
      }),
    );
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ afterEventId: 8 }),
    );
    expect(res.body).toContain(
      'data: {"eventId":8,"type":"task.progress","createdAt":"2026-08-12T10:00:08.000Z"}',
    );
    expect(res.body).not.toMatch(/payload|prompt|correlation|app-one/);

    req.emit('close');
    expect(mocks.closeSubscription).toHaveBeenCalledOnce();
    expect(ctx.state.activeStreams).toBe(0);
  });

  it('enforces the existing stream cap before replay access', async () => {
    const ctx = context();
    ctx.state.activeStreams = 1;

    const { res } = await handle(
      '/v1/activity/agent-run%3Aowned/events',
      'text/event-stream',
      ctx,
    );

    expect(res.statusCode).toBe(429);
    expect(mocks.listEvents).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(ctx.state.activeStreams).toBe(1);
  });

  it('releases the stream counter when subscription setup fails', async () => {
    mocks.subscribe.mockImplementationOnce(() => {
      throw new Error('subscription failed');
    });
    const ctx = context();

    await expect(
      handle('/v1/activity/agent-run%3Aowned/events', 'text/event-stream', ctx),
    ).rejects.toThrow('subscription failed');
    expect(ctx.state.activeStreams).toBe(0);
  });
});

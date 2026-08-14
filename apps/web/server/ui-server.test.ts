import { EventEmitter } from 'node:events';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  health: vi.fn(),
  getRuntimeSummary: vi.fn(),
  listRuntimeInstances: vi.fn(),
  listAgents: vi.fn(),
  getAgentAdmin: vi.fn(),
  getAgentDelegates: vi.fn(),
  listAgentSkills: vi.fn(),
  listSkills: vi.fn(),
  listCapabilities: vi.fn(),
  getAgentAccess: vi.fn(),
  listJobs: vi.fn(),
  getMetrics: vi.fn(),
  listActivity: vi.fn(),
  getActivity: vi.fn(),
  streamActivity: vi.fn(),
  listCreationDrafts: vi.fn(),
  createCreationDraft: vi.fn(),
  updateCreationDraft: vi.fn(),
  deleteCreationDraft: vi.fn(),
  preflightCreationDraft: vi.fn(),
  createOrResumeCreationDraft: vi.fn(),
}));

vi.mock('@gantry/sdk', () => ({ createClient: sdk.createClient }));

import { createUiHandler } from './ui-server.js';

afterEach(() => vi.useRealTimers());

function response() {
  let status = 200;
  let body = Buffer.alloc(0);
  return {
    writeHead(nextStatus: number) {
      status = nextStatus;
    },
    end(chunk?: string | Buffer) {
      body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
    },
    result() {
      return { status, text: body.toString() };
    },
  };
}

async function request(
  handler: ReturnType<typeof createUiHandler>,
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const output = response();
  const raw = options.body === undefined ? '' : JSON.stringify(options.body);
  const request = Readable.from(raw ? [raw] : []) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  request.method = options.method ?? 'GET';
  request.url = url;
  request.headers = options.headers ?? {};
  await handler(request, output);
  return output.result();
}

beforeEach(() => {
  sdk.createClient.mockReset();
  sdk.health.mockReset();
  sdk.getRuntimeSummary.mockReset();
  sdk.listRuntimeInstances.mockReset();
  sdk.listAgents.mockReset();
  sdk.getAgentAdmin.mockReset();
  sdk.getAgentDelegates.mockReset();
  sdk.listAgentSkills.mockReset();
  sdk.listSkills.mockReset();
  sdk.listCapabilities.mockReset();
  sdk.getAgentAccess.mockReset();
  sdk.listJobs.mockReset();
  sdk.getMetrics.mockReset();
  sdk.listActivity.mockReset();
  sdk.getActivity.mockReset();
  sdk.streamActivity.mockReset();
  sdk.listCreationDrafts.mockReset();
  sdk.createCreationDraft.mockReset();
  sdk.updateCreationDraft.mockReset();
  sdk.deleteCreationDraft.mockReset();
  sdk.preflightCreationDraft.mockReset();
  sdk.createOrResumeCreationDraft.mockReset();
  sdk.createClient.mockReturnValue({
    health: sdk.health,
    getRuntimeSummary: sdk.getRuntimeSummary,
    listRuntimeInstances: sdk.listRuntimeInstances,
    agents: {
      list: sdk.listAgents,
      getAdmin: sdk.getAgentAdmin,
      getDelegates: sdk.getAgentDelegates,
      getAccess: sdk.getAgentAccess,
      skills: { list: sdk.listAgentSkills },
    },
    skills: { list: sdk.listSkills },
    capabilities: { list: sdk.listCapabilities },
    jobs: { list: sdk.listJobs },
    metrics: { get: sdk.getMetrics },
    activity: {
      list: sdk.listActivity,
      get: sdk.getActivity,
      stream: sdk.streamActivity,
    },
    agentCreationDrafts: {
      list: sdk.listCreationDrafts,
      create: sdk.createCreationDraft,
      update: sdk.updateCreationDraft,
      delete: sdk.deleteCreationDraft,
      preflight: sdk.preflightCreationDraft,
      createOrResume: sdk.createOrResumeCreationDraft,
    },
  });
});

function streamRequest(url: string) {
  const request = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    destroyed: boolean;
  };
  request.method = 'GET';
  request.url = url;
  request.destroyed = false;
  return request;
}

function streamResponse() {
  const response = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    writableEnded: boolean;
    headersFlushed: boolean;
    writeHead: (status: number) => void;
    flushHeaders: () => void;
    write: (chunk: string) => boolean;
    end: (chunk?: string) => void;
    result: () => { status: number; text: string };
  };
  let status = 200;
  let body = '';
  response.destroyed = false;
  response.writableEnded = false;
  response.headersFlushed = false;
  response.writeHead = (nextStatus) => {
    status = nextStatus;
  };
  response.write = (chunk) => {
    body += chunk;
    return true;
  };
  response.flushHeaders = () => {
    response.headersFlushed = true;
  };
  response.end = (chunk) => {
    body += chunk ?? '';
    response.writableEnded = true;
  };
  response.result = () => ({ status, text: body });
  return response;
}

it('caches successful metrics requests and shares concurrent fetches', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));

  const metrics = {
    range: '24h',
    from: '2026-08-11T12:00:00.000Z',
    to: '2026-08-12T12:00:00.000Z',
    bucket: 'hour',
    usage: {
      totals: {
        requestCount: 8,
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 12,
        estimatedCostUsd: 0.42,
        credential: 'upstream-secret',
      },
      buckets: [],
      models: [],
    },
    runs: {
      total: 3,
      statuses: [{ status: 'completed', count: 3, runId: 'private-run' }],
      p95DurationMs: 900,
      correlationId: 'private-correlation',
    },
    rawEvents: [{ payload: 'private-event' }],
  };
  let resolveMetrics!: (value: typeof metrics) => void;
  sdk.getMetrics.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveMetrics = resolve;
    }),
  );
  const handler = createUiHandler({
    distRoot: '/missing',
    env: {
      GANTRY_CONTROL_API_KEY: 'server-secret',
      GANTRY_CONTROL_BASE_URL: 'http://control.internal',
    },
  });

  const first = request(handler, '/ui/api/metrics?range=24h');
  const concurrent = request(handler, '/ui/api/metrics?range=24h');
  expect(sdk.getMetrics).toHaveBeenCalledOnce();
  resolveMetrics(metrics);

  const [firstResult, concurrentResult] = await Promise.all([
    first,
    concurrent,
  ]);
  expect(firstResult).toEqual(concurrentResult);
  expect(JSON.parse(firstResult.text)).toEqual({
    range: '24h',
    from: '2026-08-11T12:00:00.000Z',
    to: '2026-08-12T12:00:00.000Z',
    bucket: 'hour',
    usage: {
      totals: {
        requestCount: 8,
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 12,
        estimatedCostUsd: 0.42,
      },
      buckets: [],
      models: [],
    },
    runs: {
      total: 3,
      statuses: [{ status: 'completed', count: 3 }],
      p95DurationMs: 900,
    },
  });
  expect(firstResult.text).not.toMatch(
    /server-secret|upstream-secret|private-run|private-correlation|private-event|rawEvents/,
  );

  await request(handler, '/ui/api/metrics');
  expect(sdk.getMetrics).toHaveBeenCalledOnce();

  expect((await request(handler, '/ui/api/metrics?range=1h')).status).toBe(400);
  expect(sdk.getMetrics).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(5 * 60_000 + 1);
  sdk.getMetrics.mockResolvedValueOnce(metrics);
  await request(handler, '/ui/api/metrics?range=24h');
  expect(sdk.getMetrics).toHaveBeenCalledTimes(2);

  sdk.getMetrics.mockRejectedValue(new Error('upstream failed'));
  expect((await request(handler, '/ui/api/metrics?range=7d')).status).toBe(503);
  expect((await request(handler, '/ui/api/metrics?range=7d')).status).toBe(503);
  expect(sdk.getMetrics).toHaveBeenCalledTimes(4);
});

it('ui-server-activity-contract', async () => {
  const run = {
    id: 'run:one',
    agentId: 'agent:one',
    cause: 'message',
    status: 'running',
    createdAt: '2026-08-12T10:00:00.000Z',
    startedAt: '2026-08-12T10:00:01.000Z',
    endedAt: null,
    durationMs: 1_000,
    resultSummary: null,
    errorSummary: null,
    conversationId: 'conversation-private',
    credential: 'upstream-secret',
  };
  const task = {
    id: 'task:one',
    agentId: 'agent:one',
    targetAgentId: 'agent:two',
    kind: 'delegated_agent',
    status: 'running',
    summary: 'Researching',
    outputSummary: null,
    errorSummary: null,
    currentPhase: 'Gathering sources',
    lastProgress: 'Found two sources',
    lastToolSummary: null,
    blocker: null,
    createdAt: '2026-08-12T10:00:02.000Z',
    updatedAt: '2026-08-12T10:00:03.000Z',
    startedAt: '2026-08-12T10:00:02.000Z',
    terminalAt: null,
    durationMs: 1_000,
    children: [],
    authoritySnapshotJson: { credential: 'authority-private' },
    privateCorrelationJson: { conversationId: 'conversation-private' },
    logs: ['log-private'],
  };
  sdk.listActivity.mockResolvedValue({
    runs: [run],
    rawEvents: [{ payload: 'raw-private' }],
  });
  sdk.getActivity.mockResolvedValue({
    run,
    tasks: [{ ...task, children: [{ ...task, id: 'task:child' }] }],
    taskTotal: 2,
    truncated: false,
    provider: 'provider-private',
  });
  sdk.streamActivity.mockImplementation(async function* (_runId, input) {
    input.onOpen();
    yield {
      eventId: 7,
      type: 'agent.run.updated',
      createdAt: '2026-08-12T10:00:04.000Z',
      payload: 'raw-private',
      correlationId: 'correlation-private',
    };
  });

  const handler = createUiHandler({
    distRoot: '/missing',
    env: {
      GANTRY_CONTROL_API_KEY: 'server-secret',
      GANTRY_CONTROL_BASE_URL: 'http://control.internal',
    },
  });
  const list = await request(handler, '/ui/api/activity');
  const detail = await request(handler, '/ui/api/activity/run%3Aone');
  const streamReq = streamRequest(
    '/ui/api/activity/run%3Aone/events?afterEventId=6',
  );
  const streamRes = streamResponse();
  await handler(streamReq, streamRes);

  expect(JSON.parse(list.text)).toEqual({
    runs: [
      {
        id: 'run:one',
        agentId: 'agent:one',
        cause: 'message',
        status: 'running',
        createdAt: '2026-08-12T10:00:00.000Z',
        startedAt: '2026-08-12T10:00:01.000Z',
        endedAt: null,
        durationMs: 1_000,
        resultSummary: null,
        errorSummary: null,
      },
    ],
  });
  expect(JSON.parse(detail.text)).toEqual({
    run: JSON.parse(list.text).runs[0],
    tasks: [
      {
        id: 'task:one',
        agentId: 'agent:one',
        targetAgentId: 'agent:two',
        kind: 'delegated_agent',
        status: 'running',
        summary: 'Researching',
        outputSummary: null,
        errorSummary: null,
        currentPhase: 'Gathering sources',
        lastProgress: 'Found two sources',
        lastToolSummary: null,
        blocker: null,
        createdAt: '2026-08-12T10:00:02.000Z',
        updatedAt: '2026-08-12T10:00:03.000Z',
        startedAt: '2026-08-12T10:00:02.000Z',
        terminalAt: null,
        durationMs: 1_000,
        children: [expect.objectContaining({ id: 'task:child', children: [] })],
      },
    ],
    taskTotal: 2,
    truncated: false,
  });
  expect(streamRes.result()).toEqual({
    status: 200,
    text: 'data: {"eventId":7,"type":"agent.run.updated","createdAt":"2026-08-12T10:00:04.000Z"}\n\n',
  });
  expect(streamRes.headersFlushed).toBe(true);
  expect(sdk.getActivity).toHaveBeenCalledWith('run:one');
  expect(sdk.streamActivity).toHaveBeenCalledWith('run:one', {
    afterEventId: 6,
    signal: expect.any(AbortSignal),
    onOpen: expect.any(Function),
  });
  expect(sdk.streamActivity.mock.calls[0][1].signal.aborted).toBe(true);
  expect(list.text + detail.text + streamRes.result().text).not.toMatch(
    /server-secret|upstream-secret|conversation-private|authority-private|log-private|raw-private|correlation-private|provider-private/,
  );

  sdk.getActivity.mockRejectedValue(new Error('server-secret failed'));
  const failure = await request(handler, '/ui/api/activity/run%3Atwo');
  expect(failure.status).toBe(503);
  expect(JSON.parse(failure.text)).toMatchObject({
    error: { code: 'CONTROL_API_UNAVAILABLE', retryable: true },
  });
  expect(failure.text).not.toContain('server-secret');

  sdk.getActivity.mockRejectedValue(
    Object.assign(new Error('Run not found'), { code: 'RUN_NOT_FOUND' }),
  );
  const missingRun = await request(handler, '/ui/api/activity/run%3Amissing');
  expect(missingRun.status).toBe(404);
  expect(JSON.parse(missingRun.text)).toMatchObject({
    error: { code: 'RUN_NOT_FOUND', retryable: false },
  });

  const invalid = await request(
    handler,
    '/ui/api/activity/run%3Aone/events?afterEventId=-1',
  );
  expect(invalid.status).toBe(400);
  expect(JSON.parse(invalid.text)).toMatchObject({
    error: { code: 'INVALID_ACTIVITY_CURSOR', retryable: false },
  });

  let disconnectSignal: AbortSignal | undefined;
  sdk.streamActivity.mockImplementation((_runId, input) => {
    disconnectSignal = input.signal;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<never>>((resolve) =>
            input.signal.addEventListener(
              'abort',
              () => resolve({ done: true, value: undefined as never }),
              { once: true },
            ),
          ),
      }),
    };
  });
  const disconnectReq = streamRequest('/ui/api/activity/run%3Aone/events');
  const disconnectRes = streamResponse();
  const disconnected = handler(disconnectReq, disconnectRes);
  await vi.waitFor(() => expect(disconnectSignal).toBeDefined());
  disconnectRes.destroyed = true;
  disconnectRes.emit('close');
  await disconnected;
  expect(disconnectSignal?.aborted).toBe(true);

  let failureSignal: AbortSignal | undefined;
  sdk.streamActivity.mockImplementation((_runId, input) => {
    failureSignal = input.signal;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('upstream stream failed')),
      }),
    };
  });
  const failedRes = streamResponse();
  await handler(streamRequest('/ui/api/activity/run%3Aone/events'), failedRes);
  expect(failureSignal?.aborted).toBe(true);
  expect(failedRes.writableEnded).toBe(true);
  expect(failedRes.headersFlushed).toBe(false);
  expect(failedRes.result().status).toBe(503);
  expect(JSON.parse(failedRes.result().text)).toMatchObject({
    error: { code: 'CONTROL_API_UNAVAILABLE', retryable: true },
  });

  sdk.streamActivity.mockImplementation(() => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        Promise.reject(
          Object.assign(new Error('Too many streams'), {
            code: 'TOO_MANY_STREAMS',
          }),
        ),
    }),
  }));
  const cappedRes = streamResponse();
  await handler(streamRequest('/ui/api/activity/run%3Aone/events'), cappedRes);
  expect(cappedRes.headersFlushed).toBe(false);
  expect(cappedRes.result().status).toBe(429);
  expect(JSON.parse(cappedRes.result().text)).toMatchObject({
    error: { code: 'ACTIVITY_STREAM_LIMIT', retryable: true },
  });
});

it('ui-server-profile-contract', async () => {
  sdk.getAgentAdmin.mockResolvedValue({
    agent: {
      id: 'agent:one',
      appId: 'private-app',
      name: 'One',
      status: 'active',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T01:00:00.000Z',
      currentConfigVersionId: 'secret-version',
    },
    capabilities: { rawPolicy: 'upstream-secret' },
    boundConversations: [
      { conversationId: 'private-conversation', provider: 'slack' },
    ],
  });
  sdk.getAgentDelegates.mockResolvedValue({
    delegates: ['researcher'],
    resolved: [{ toolName: 'delegate_secret' }],
  });
  sdk.listAgentSkills.mockResolvedValue({
    bindings: [{ configVersionId: 'secret-version' }],
  });
  sdk.getAgentAccess.mockResolvedValue({
    sources: { privateSource: 'upstream-secret' },
    summary: {
      connected: [{ label: 'Browser', detail: 'Connected' }],
      allowed: [],
      needsAttention: [{ label: 'Files', detail: 'Needs approval' }],
      suggestedCleanup: [],
    },
  });

  const profile = await request(
    createUiHandler({
      distRoot: '/missing',
      env: {
        GANTRY_CONTROL_API_KEY: 'server-secret',
        GANTRY_CONTROL_BASE_URL: 'http://control.internal',
      },
    }),
    '/ui/api/agents/agent%3Aone',
  );

  expect(profile.status).toBe(200);
  expect(JSON.parse(profile.text)).toEqual({
    agent: {
      id: 'agent:one',
      name: 'One',
      status: 'active',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T01:00:00.000Z',
    },
    boundConversationCount: 1,
    counts: {
      configuredDelegates: 1,
      boundSkills: 1,
      selectedCapabilities: 0,
      access: {
        connected: 1,
        allowed: 0,
        needsAttention: 1,
        suggestedCleanup: 0,
      },
    },
    unavailable: [],
  });
  expect(profile.text).not.toMatch(
    /server-secret|control\.internal|upstream-secret|private-app|secret-version|delegate_secret|private-conversation|rawPolicy|privateSource/,
  );
});

it('ui-server-agent-creation-contract', async () => {
  sdk.createCreationDraft.mockResolvedValue({
    id: 'agent-creation-draft:one',
    revision: 1,
    status: 'draft',
    currentStep: 'identity',
    document: {
      name: 'Support',
      agentHarness: 'auto',
      appId: 'private-app',
      capabilities: [],
      skillIds: [],
      mcpServerIds: [],
      toolSources: [],
      delegateIds: [],
      workSource: { kind: 'configure_later' },
    },
    progress: { identity: 'complete' },
    appId: 'private-app',
    leaseToken: 'secret-lease',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  });
  const handler = createUiHandler({
    distRoot: '/missing',
    env: {
      GANTRY_CONTROL_API_KEY: 'server-secret',
      GANTRY_CONTROL_BASE_URL: 'http://control.internal',
    },
  });
  const body = {
    document: {
      name: 'Support',
      agentHarness: 'auto',
      capabilities: [],
      skillIds: [],
      mcpServerIds: [],
      toolSources: [],
      delegateIds: [],
      workSource: { kind: 'configure_later' },
    },
  };

  expect(
    (
      await request(handler, '/ui/api/agent-creation-drafts', {
        method: 'POST',
        body,
      })
    ).status,
  ).toBe(403);

  const created = await request(handler, '/ui/api/agent-creation-drafts', {
    method: 'POST',
    body,
    headers: {
      origin: 'http://ui.local',
      host: 'ui.local',
      'content-type': 'application/json',
    },
  });
  expect(created.status).toBe(201);
  expect(created.text).not.toMatch(
    /server-secret|control\.internal|secret-lease|private-app/,
  );
  expect(JSON.parse(created.text)).toMatchObject({
    id: 'agent-creation-draft:one',
    document: { name: 'Support', agentHarness: 'auto' },
  });
  expect(sdk.createCreationDraft).toHaveBeenCalledWith(body);
});

it('ui-server-api-contract', async () => {
  const distRoot = await mkdtemp(join(tmpdir(), 'gantry-ui-'));
  await writeFile(join(distRoot, 'index.html'), '<main>Gantry</main>');
  const handler = createUiHandler({ distRoot, env: {} });

  expect(await request(handler, '/ui')).toEqual({
    status: 200,
    text: '<main>Gantry</main>',
  });
  expect(await request(handler, '/ui/agents/agent-1')).toEqual({
    status: 200,
    text: '<main>Gantry</main>',
  });
  expect((await request(handler, '/ui/%2e%2e%2fpackage.json')).status).toBe(
    404,
  );
  const outside = join(distRoot, '..', 'outside.txt');
  await writeFile(outside, 'server-secret');
  await symlink(outside, join(distRoot, 'outside.txt'));
  expect((await request(handler, '/ui/outside.txt')).status).toBe(404);

  const missing = await request(
    createUiHandler({
      distRoot: '/missing',
      env: { GANTRY_CONTROL_API_KEY: 'server-secret' },
    }),
    '/ui/api/connection',
  );
  expect(missing.status).toBe(503);
  expect(JSON.parse(missing.text)).toMatchObject({
    error: { code: 'UI_NOT_CONFIGURED', retryable: false },
  });

  sdk.health.mockResolvedValue({
    status: 'ok',
    processRole: 'control',
    transport: { kind: 'unix', socketPath: '/private/runtime.sock' },
    features: {
      sessions: true,
      jobs: false,
      events: true,
      webhooks: false,
      credential: 'upstream-secret',
    },
    scopes: ['agents:admin'],
  });
  sdk.listAgents.mockResolvedValue({
    agents: [
      {
        id: 'agent:one',
        appId: 'private-app',
        name: 'One',
        status: 'active',
        agentHarness: 'auto',
        currentConfigVersionId: 'secret-version',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T01:00:00.000Z',
        credential: 'upstream-secret',
      },
    ],
  });
  sdk.getRuntimeSummary.mockResolvedValue({
    role: 'control',
    status: 'degraded',
    uptimeSeconds: 120,
    capacity: { liveLimit: 4, jobLimit: 2 },
    counts: { instances: 2, liveWorkers: 1, jobWorkers: 0, stale: 1 },
    readiness: {
      status: 'degraded',
      checks: {
        database: 'pass',
        migrations: 'pass',
        settings: 'pass',
        draining: false,
        apiAuth: 'pass',
        workerRegistered: 'fail',
        scheduler: 'fail',
        secretCheck: 'upstream-secret',
      },
      failing: ['scheduler'],
    },
  });
  sdk.listRuntimeInstances.mockResolvedValue({
    instances: [
      {
        id: 'control:one',
        role: 'control',
        status: 'running',
        heartbeat: { status: 'not-applicable', at: null },
        readiness: {
          status: 'degraded',
          checks: {
            database: 'pass',
            migrations: 'pass',
            settings: 'pass',
            draining: false,
            scheduler: 'fail',
          },
          failing: ['scheduler'],
        },
        capacity: { liveLimit: 4, jobLimit: 2 },
        capabilities: ['control-api'],
        startedAt: '2026-08-12T00:00:00.000Z',
        lastSeenAt: '2026-08-12T01:00:00.000Z',
        leaseToken: 'upstream-secret',
      },
      {
        id: 'worker:one',
        role: 'live-worker',
        status: 'unhealthy',
        heartbeat: {
          status: 'stale',
          at: '2026-08-12T00:30:00.000Z',
        },
        readiness: null,
        capacity: { liveLimit: 1, jobLimit: null },
        capabilities: ['live-execution'],
        startedAt: '2026-08-12T00:00:00.000Z',
        lastSeenAt: '2026-08-12T00:30:00.000Z',
      },
    ],
  });
  sdk.getAgentAdmin.mockResolvedValue({
    agent: {
      id: 'agent:one',
      appId: 'private-app',
      name: 'One',
      status: 'active',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T01:00:00.000Z',
      currentConfigVersionId: 'secret-version',
    },
    capabilities: {
      capabilities: [{ id: 'browser.read', version: '1' }],
      rawPolicy: 'upstream-secret',
    },
    boundConversations: [
      { conversationId: 'private-conversation', provider: 'slack' },
    ],
  });
  sdk.getAgentDelegates.mockResolvedValue({
    delegates: ['researcher'],
    resolved: [
      {
        ref: 'researcher',
        agentId: 'agent:researcher',
        toolName: 'delegate_secret',
        displayName: 'Researcher',
        persona: 'research',
      },
    ],
    revision: 2,
  });
  sdk.listAgentSkills.mockResolvedValue({
    bindings: [
      {
        id: 'binding:one',
        skillId: 'skill:summary',
        status: 'enabled',
        updatedAt: '2026-08-12T01:00:00.000Z',
        configVersionId: 'secret-version',
      },
    ],
  });
  sdk.listSkills.mockResolvedValue({
    skills: [
      {
        id: 'skill:summary',
        name: 'Summary',
        description: 'Creates a short summary.',
        requiredEnvVars: ['PRIVATE'],
      },
    ],
  });
  sdk.listCapabilities.mockResolvedValue({
    capabilities: [
      {
        id: 'browser.read',
        displayName: 'Browser',
        category: 'Browser',
        risk: 'write',
        version: 'catalog',
        can: 'Read pages.',
        cannot: 'Expose secrets.',
        sourceRefs: { secret: true },
      },
    ],
  });
  sdk.getAgentAccess.mockResolvedValue({
    updatedAt: '2026-08-12T01:00:00.000Z',
    sources: { privateSource: 'upstream-secret' },
    selections: [{ id: 'browser.read', version: '1' }],
    toolAccess: { rawPolicy: 'upstream-secret' },
    summary: {
      connected: [{ label: 'Browser', detail: 'Connected' }],
      allowed: [],
      needsAttention: [{ label: 'Files', detail: 'Needs approval' }],
      suggestedCleanup: [],
    },
  });
  sdk.listJobs.mockResolvedValue({
    jobs: [
      {
        jobId: 'job:one',
        name: 'Daily brief',
        kind: 'recurring',
        status: 'active',
        lastRun: '2026-08-12T00:00:00.000Z',
        nextRun: '2026-08-13T00:00:00.000Z',
        prompt: 'upstream-secret',
      },
    ],
  });
  sdk.listActivity.mockResolvedValue({ runs: [] });
  const connected = createUiHandler({
    distRoot: '/missing',
    env: {
      GANTRY_CONTROL_API_KEY: 'server-secret',
      GANTRY_CONTROL_BASE_URL: 'http://control.internal',
    },
  });

  const connection = await request(connected, '/ui/api/connection');
  const agents = await request(connected, '/ui/api/agents');
  const overview = await request(connected, '/ui/api/overview');
  const instances = await request(connected, '/ui/api/instances');
  const instance = await request(connected, '/ui/api/instances/worker%3Aone');
  const agent = await request(connected, '/ui/api/agents/agent%3Aone');
  const delegation = await request(
    connected,
    '/ui/api/agents/agent%3Aone/delegation',
  );
  const skills = await request(connected, '/ui/api/agents/agent%3Aone/skills');
  const capabilities = await request(
    connected,
    '/ui/api/agents/agent%3Aone/capabilities',
  );
  const access = await request(connected, '/ui/api/agents/agent%3Aone/access');
  const activity = await request(
    connected,
    '/ui/api/agents/agent%3Aone/activity',
  );

  expect(JSON.parse(connection.text)).toEqual({
    status: 'ok',
    processRole: 'control',
    features: { sessions: true, jobs: false, events: true, webhooks: false },
  });
  expect(JSON.parse(agents.text)).toEqual({
    agents: [
      {
        id: 'agent:one',
        name: 'One',
        status: 'active',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T01:00:00.000Z',
      },
    ],
  });
  expect(JSON.parse(overview.text)).toMatchObject({
    deployment: {
      role: 'control',
      status: 'degraded',
      readiness: {
        checks: { apiAuth: 'pass', workerRegistered: 'fail' },
      },
    },
    instanceCounts: { instances: 2, stale: 1 },
    agentCounts: { total: 1, active: 1, disabled: 0 },
    unavailable: [],
    attention: { status: 'attention', to: '/instances' },
  });
  expect(JSON.parse(instances.text)).toEqual({
    instances: expect.arrayContaining([
      expect.objectContaining({
        id: 'worker:one',
        role: 'live-worker',
        heartbeat: { status: 'stale', at: '2026-08-12T00:30:00.000Z' },
      }),
    ]),
  });
  expect(JSON.parse(instance.text)).toEqual({
    instance: expect.objectContaining({ id: 'worker:one' }),
  });
  expect(JSON.parse(agent.text)).toEqual({
    agent: {
      id: 'agent:one',
      name: 'One',
      status: 'active',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T01:00:00.000Z',
    },
    boundConversationCount: 1,
    counts: {
      configuredDelegates: 1,
      boundSkills: 1,
      selectedCapabilities: 1,
      access: {
        connected: 1,
        allowed: 0,
        needsAttention: 1,
        suggestedCleanup: 0,
      },
    },
    unavailable: [],
  });
  expect(JSON.parse(delegation.text)).toEqual({
    configured: ['researcher'],
    resolved: [
      {
        ref: 'researcher',
        agentId: 'agent:researcher',
        displayName: 'Researcher',
        persona: 'research',
      },
    ],
  });
  expect(JSON.parse(skills.text)).toEqual({
    skills: [
      {
        id: 'skill:summary',
        name: 'Summary',
        description: 'Creates a short summary.',
        status: 'enabled',
        updatedAt: '2026-08-12T01:00:00.000Z',
      },
    ],
  });
  expect(JSON.parse(capabilities.text)).toEqual({
    capabilities: [
      {
        id: 'browser.read',
        displayName: 'Browser',
        category: 'Browser',
        risk: 'write',
        version: '1',
        can: 'Read pages.',
        cannot: 'Expose secrets.',
      },
    ],
  });
  expect(JSON.parse(access.text)).toEqual({
    updatedAt: '2026-08-12T01:00:00.000Z',
    summary: {
      connected: [{ label: 'Browser', detail: 'Connected' }],
      allowed: [],
      needsAttention: [{ label: 'Files', detail: 'Needs approval' }],
      suggestedCleanup: [],
    },
  });
  expect(JSON.parse(activity.text)).toEqual({
    runs: [],
    jobs: [
      {
        id: 'job:one',
        name: 'Daily brief',
        kind: 'recurring',
        status: 'active',
        lastRun: '2026-08-12T00:00:00.000Z',
        nextRun: '2026-08-13T00:00:00.000Z',
      },
    ],
  });
  expect(sdk.createClient).toHaveBeenCalledWith({
    apiKey: 'server-secret',
    baseUrl: 'http://control.internal',
    socketPath: undefined,
    timeoutMs: 10_000,
  });
  expect(sdk.health).toHaveBeenCalledOnce();
  expect(sdk.listAgents).toHaveBeenCalledTimes(2);
  expect(sdk.getRuntimeSummary).toHaveBeenCalledOnce();
  expect(sdk.listRuntimeInstances).toHaveBeenCalledTimes(2);
  expect(sdk.getAgentAdmin).toHaveBeenCalledTimes(2);
  expect(sdk.getAgentDelegates).toHaveBeenCalledTimes(2);
  expect(sdk.listAgentSkills).toHaveBeenCalledTimes(2);
  expect(sdk.listSkills).toHaveBeenCalledOnce();
  expect(sdk.listCapabilities).toHaveBeenCalledOnce();
  expect(sdk.getAgentAccess).toHaveBeenCalledTimes(2);
  expect(sdk.listJobs).toHaveBeenCalledWith({
    agentId: 'agent:one',
    limit: 20,
  });
  expect(
    connection.text +
      agents.text +
      overview.text +
      instances.text +
      instance.text +
      agent.text +
      delegation.text +
      skills.text +
      capabilities.text +
      access.text +
      activity.text,
  ).not.toMatch(
    /server-secret|control\.internal|runtime\.sock|agents:admin|upstream-secret|private-app|secret-version|delegate_secret|private-conversation/,
  );

  sdk.listAgents.mockRejectedValue(
    new Error('token server-secret failed at /private/runtime.sock'),
  );
  const failure = await request(
    createUiHandler({
      distRoot: '/missing',
      env: {
        GANTRY_CONTROL_API_KEY: 'server-secret',
        GANTRY_CONTROL_SOCKET_PATH: '/private/runtime.sock',
      },
    }),
    '/ui/api/agents',
  );
  const body = JSON.parse(failure.text);
  expect(failure.status).toBe(503);
  expect(body).toMatchObject({
    error: { code: 'CONTROL_API_UNAVAILABLE', retryable: true },
  });
  expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(failure.text).not.toMatch(
    /server-secret|runtime\.sock|agents:admin|RAW_CONTROL_ERROR/,
  );

  sdk.listAgents.mockRejectedValue(new Error('agent list unavailable'));
  const partialOverview = await request(connected, '/ui/api/overview');
  expect(partialOverview.status).toBe(200);
  expect(JSON.parse(partialOverview.text)).toMatchObject({
    deployment: { role: 'control', status: 'degraded' },
    instanceCounts: { instances: 2, stale: 1 },
    agentCounts: null,
    unavailable: ['agents'],
  });
});

import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  health: vi.fn(),
  getRuntimeSummary: vi.fn(),
  listRuntimeInstances: vi.fn(),
  listAgents: vi.fn(),
  getAgentAdmin: vi.fn(),
  getAgentDelegates: vi.fn(),
  listAgentSkills: vi.fn(),
  getAgentAccess: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock('@gantry/sdk', () => ({ createClient: sdk.createClient }));

import { createUiHandler } from './ui-server.js';

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
) {
  const output = response();
  await handler({ method: 'GET', url }, output);
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
  sdk.getAgentAccess.mockReset();
  sdk.listJobs.mockReset();
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
    jobs: { list: sdk.listJobs },
  });
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
    deployment: { role: 'control', status: 'degraded' },
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
        id: 'binding:one',
        skillId: 'skill:summary',
        status: 'enabled',
        updatedAt: '2026-08-12T01:00:00.000Z',
      },
    ],
  });
  expect(JSON.parse(capabilities.text)).toEqual({
    capabilities: [{ id: 'browser.read', version: '1' }],
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
    activity: [
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
  expect(sdk.getAgentDelegates).toHaveBeenCalledOnce();
  expect(sdk.listAgentSkills).toHaveBeenCalledOnce();
  expect(sdk.getAgentAccess).toHaveBeenCalledOnce();
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

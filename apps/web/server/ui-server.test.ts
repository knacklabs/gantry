import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  health: vi.fn(),
  listAgents: vi.fn(),
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
  sdk.listAgents.mockReset();
  sdk.createClient.mockReturnValue({
    health: sdk.health,
    agents: { list: sdk.listAgents },
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
  const connected = createUiHandler({
    distRoot: '/missing',
    env: {
      GANTRY_CONTROL_API_KEY: 'server-secret',
      GANTRY_CONTROL_BASE_URL: 'http://control.internal',
    },
  });

  const connection = await request(connected, '/ui/api/connection');
  const agents = await request(connected, '/ui/api/agents');

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
  expect(sdk.createClient).toHaveBeenCalledWith({
    apiKey: 'server-secret',
    baseUrl: 'http://control.internal',
    socketPath: undefined,
    timeoutMs: 10_000,
  });
  expect(sdk.health).toHaveBeenCalledOnce();
  expect(sdk.listAgents).toHaveBeenCalledOnce();
  expect(connection.text + agents.text).not.toMatch(
    /server-secret|control\.internal|runtime\.sock|agents:admin|upstream-secret|private-app/,
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
});

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/config/index.js', () => ({
  MYCLAW_HOME: '/tmp/myclaw-control-test-home',
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isSchedulerReady: vi.fn(() => true),
  requestSchedulerSync: vi.fn(),
}));

const controlRepo = {
  listDueWebhookDeliveries: vi.fn(async () => []),
  claimDueWebhookDeliveries: vi.fn(async () => []),
  ensureAppSession: vi.fn(async (input: any) => ({
    sessionId: 'session-1',
    appId: input.appId,
    conversationId: input.conversationId,
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    title: input.title ?? null,
    defaultResponseMode: input.defaultResponseMode ?? 'sse',
    defaultWebhookId: input.defaultWebhookId ?? null,
  })),
  registerWebhook: vi.fn(async (input: any) => ({
    webhookId: 'webhook-1',
    appId: input.appId,
    name: input.name,
    url: input.url,
    secret: input.secret,
    enabled: input.enabled,
  })),
  listWebhooks: vi.fn(async () => []),
  updateWebhook: vi.fn(
    async (_webhookId: string, appId: string, patch: any) => ({
      webhookId: 'webhook-1',
      appId,
      name: patch.name ?? 'webhook-name',
      url: patch.url ?? 'https://example.com/hook',
      enabled: patch.enabled ?? true,
    }),
  ),
  deleteWebhook: vi.fn(async () => undefined),
  getWebhookById: vi.fn(async () => null),
  getAppSessionById: vi.fn(async () => null),
  addControlEvent: vi.fn(async () => ({ eventId: 1001 })),
  upsertAppResponseRoute: vi.fn(async () => undefined),
  replayWebhookDeadLetters: vi.fn(async () => 0),
  purgeWebhookDeadLetters: vi.fn(async () => 0),
  markWebhookDeliveryDelivered: vi.fn(async () => undefined),
  markWebhookDeliveryRetry: vi.fn(async () => undefined),
  markWebhookDeliveryDead: vi.fn(async () => undefined),
};

const opsRepo = {
  storeChatMetadata: vi.fn(async () => undefined),
  storeMessage: vi.fn(async () => undefined),
};

const memoryService = {
  isEnabled: vi.fn(() => true),
  save: vi.fn(async (input: any) => ({ id: 'mem-1', ...input })),
  list: vi.fn(async () => []),
  search: vi.fn(async () => []),
  patch: vi.fn(async (input: any) => ({ id: input.id, ...input })),
  delete: vi.fn(async () => ({ deleted: true })),
  triggerDreaming: vi.fn(async (input: any) => ({
    runId: 'dream-1',
    appId: input.appId,
    agentId: input.agentId ?? 'main',
    subjectType: input.subjectType ?? 'group',
    subjectId: input.subjectId ?? 'default',
    phase: input.phase ?? 'all',
    status: 'completed',
    summary: {},
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
  })),
  dreamingStatus: vi.fn(async () => []),
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
  getRuntimeOpsRepository: () => opsRepo,
}));

vi.mock('@core/memory/app-memory-service.js', () => ({
  AppMemoryService: {
    getInstance: () => memoryService,
  },
}));

import {
  _testControlServer,
  startControlServer,
} from '@core/control/server/index.js';

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve test port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for socket: ${socketPath}`);
}

async function waitForSocketMode(
  socketPath: string,
  expectedMode: number,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      const mode = fs.statSync(socketPath).mode & 0o777;
      if (mode === expectedMode) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for socket mode ${expectedMode.toString(8)}`,
  );
}

async function requestWithRetry(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + 3000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.headers || {}),
        },
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Control server did not start in time');
}

beforeEach(() => {
  vi.clearAllMocks();
  controlRepo.listDueWebhookDeliveries.mockResolvedValue([]);
  controlRepo.claimDueWebhookDeliveries.mockResolvedValue([]);
  controlRepo.listWebhooks.mockResolvedValue([]);
  controlRepo.getWebhookById.mockResolvedValue(null);
  controlRepo.getAppSessionById.mockResolvedValue(null);
  controlRepo.addControlEvent.mockResolvedValue({ eventId: 1001 });
  controlRepo.upsertAppResponseRoute.mockResolvedValue(undefined);
  controlRepo.replayWebhookDeadLetters.mockResolvedValue(0);
  controlRepo.purgeWebhookDeadLetters.mockResolvedValue(0);
  controlRepo.markWebhookDeliveryDelivered.mockResolvedValue(undefined);
  controlRepo.markWebhookDeliveryRetry.mockResolvedValue(undefined);
  controlRepo.markWebhookDeliveryDead.mockResolvedValue(undefined);
  opsRepo.storeChatMetadata.mockResolvedValue(undefined);
  opsRepo.storeMessage.mockResolvedValue(undefined);
  memoryService.isEnabled.mockReturnValue(true);
  memoryService.save.mockClear();
  memoryService.list.mockClear();
  memoryService.search.mockClear();
  memoryService.patch.mockClear();
  memoryService.delete.mockClear();
  memoryService.triggerDreaming.mockClear();
  memoryService.dreamingStatus.mockClear();
});

afterEach(() => {
  delete process.env.MYCLAW_CONTROL_API_KEYS_JSON;
  delete process.env.MYCLAW_CONTROL_API_KEY;
  delete process.env.MYCLAW_CONTROL_APP_ID;
  delete process.env.MYCLAW_CONTROL_PORT;
  delete process.env.MYCLAW_CONTROL_SOCKET_PATH;
  delete process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
});

describe('control server auth key parsing', () => {
  it('filters out JSON keys that are not app-bound', () => {
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'missing-app',
        token: 'token-a',
        scopes: ['sessions:read'],
      },
      {
        kid: 'valid',
        token: 'token-b',
        appId: 'app-one',
        scopes: ['sessions:read'],
      },
      {
        kid: 'unsafe-app',
        token: 'token-c',
        appId: 'app:two',
        scopes: ['sessions:read'],
      },
    ]);

    const keys = _testControlServer.parseControlApiKeys();

    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe('valid');
    expect(keys[0]?.appId).toBe('app-one');
  });

  it('requires MYCLAW_CONTROL_APP_ID for single-token auth', () => {
    process.env.MYCLAW_CONTROL_API_KEY = 'single-token';
    expect(_testControlServer.parseControlApiKeys()).toHaveLength(0);

    process.env.MYCLAW_CONTROL_APP_ID = 'app:unsafe';
    expect(_testControlServer.parseControlApiKeys()).toHaveLength(0);

    process.env.MYCLAW_CONTROL_APP_ID = 'app-two';
    const keys = _testControlServer.parseControlApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.appId).toBe('app-two');
  });

  it('enforces strict app access matching', () => {
    const auth = {
      kid: 'k',
      tokenHash: Buffer.alloc(32),
      scopes: new Set(['sessions:read']),
      appId: 'app-alpha',
    } as any;
    expect(_testControlServer.canAccessApp(auth, 'app-alpha')).toBe(true);
    expect(_testControlServer.canAccessApp(auth, 'app-beta')).toBe(false);
    expect(_testControlServer.canAccessApp(auth, null)).toBe(false);
    expect(_testControlServer.canAccessApp(auth, undefined)).toBe(false);
  });

  it('rejects delimiter-bearing app and conversation ids', () => {
    expect(_testControlServer.isValidControlId('app-one')).toBe(true);
    expect(_testControlServer.isValidControlId('conv.1_2-3')).toBe(true);
    expect(_testControlServer.isValidControlId('foo:bar')).toBe(false);
    expect(_testControlServer.isValidControlId('')).toBe(false);
  });

  it('classifies non-public webhook addresses broadly', () => {
    expect(_testControlServer.isPrivateAddress('127.0.0.1')).toBe(true);
    expect(_testControlServer.isPrivateAddress('127.1.2.3')).toBe(true);
    expect(_testControlServer.isPrivateAddress('0.1.2.3')).toBe(true);
    expect(_testControlServer.isPrivateAddress('10.2.3.4')).toBe(true);
    expect(_testControlServer.isPrivateAddress('100.64.1.2')).toBe(true);
    expect(_testControlServer.isPrivateAddress('169.254.1.2')).toBe(true);
    expect(_testControlServer.isPrivateAddress('172.20.1.2')).toBe(true);
    expect(_testControlServer.isPrivateAddress('192.168.1.2')).toBe(true);
    expect(_testControlServer.isPrivateAddress('198.18.1.2')).toBe(true);
    expect(_testControlServer.isPrivateAddress('203.0.113.10')).toBe(true);
    expect(_testControlServer.isPrivateAddress('::1')).toBe(true);
    expect(_testControlServer.isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(_testControlServer.isPrivateAddress('fc00::1')).toBe(true);
    expect(_testControlServer.isPrivateAddress('fe80::1')).toBe(true);
    expect(_testControlServer.isPrivateAddress('2001:db8::1')).toBe(true);
    expect(_testControlServer.isPrivateAddress('8.8.8.8')).toBe(false);
    expect(_testControlServer.isPrivateAddress('2606:4700:4700::1111')).toBe(
      false,
    );
  });

  it('does not authorize jobs by ambiguous app id prefix', () => {
    const job = {
      linked_sessions: ['app:foo:bar:conv'],
    } as any;

    expect(_testControlServer.jobBelongsToApp(job, 'foo')).toBe(false);
    expect(_testControlServer.jobBelongsToApp(job, 'foo:bar')).toBe(false);
    expect(_testControlServer.jobBelongsToApp(job, 'fo')).toBe(false);
    expect(
      _testControlServer.jobBelongsToApp(
        { linked_sessions: ['app:foo:conv'] } as any,
        'foo',
      ),
    ).toBe(true);
  });

  it('keeps app group folders collision-resistant for distinct valid ids', () => {
    const dashed = _testControlServer.makeAppGroup({
      appId: 'app-one',
      conversationId: 'conv',
      chatJid: 'app:app-one:conv',
    });
    const dotted = _testControlServer.makeAppGroup({
      appId: 'app.one',
      conversationId: 'conv',
      chatJid: 'app:app.one:conv',
    });
    const cased = _testControlServer.makeAppGroup({
      appId: 'App',
      conversationId: 'conv',
      chatJid: 'app:App:conv',
    });
    const lower = _testControlServer.makeAppGroup({
      appId: 'app',
      conversationId: 'conv',
      chatJid: 'app:app:conv',
    });

    expect(dashed.folder).not.toBe(dotted.folder);
    expect(cased.folder).not.toBe(lower.folder);
    expect(dashed.folder).toMatch(/^app_[a-f0-9]{12}_app_one_conv$/);
  });

  it('keeps app group hash suffix non-truncatable for max-length ids', () => {
    const prefix = 'a'.repeat(64);
    const first = _testControlServer.makeAppGroup({
      appId: prefix,
      conversationId: `${'b'.repeat(63)}1`,
      chatJid: `app:${prefix}:${'b'.repeat(63)}1`,
    });
    const second = _testControlServer.makeAppGroup({
      appId: prefix,
      conversationId: `${'b'.repeat(63)}2`,
      chatJid: `app:${prefix}:${'b'.repeat(63)}2`,
    });

    expect(first.folder).not.toBe(second.folder);
    expect(first.folder).toMatch(/^app_[a-f0-9]{12}_/);
    expect(second.folder).toMatch(/^app_[a-f0-9]{12}_/);
    expect(first.folder.length).toBeLessThanOrEqual(96);
    expect(second.folder.length).toBeLessThanOrEqual(96);
  });
});

describe('control server runtime hardening', () => {
  it('rejects bearer auth when key is not app-bound', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'missing-app',
        token: 'bad-key',
        scopes: ['sessions:read'],
      },
    ]);

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });
    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/health`,
        'bad-key',
      );
      expect(response.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('sets unix socket mode to 0600', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-control-socket-'),
    );
    const socketPath = path.join(tempDir, 'control.sock');
    process.env.MYCLAW_CONTROL_SOCKET_PATH = socketPath;
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 't',
        scopes: ['sessions:read'],
        appId: 'app-one',
      },
    ]);

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      await waitForSocket(socketPath);
      await waitForSocketMode(socketPath, 0o600);
      const mode = fs.statSync(socketPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await handle.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('closes the control server when socket chmod fails', () => {
    const close = vi.fn();
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('chmod failed');
    });

    expect(
      _testControlServer.applyControlSocketMode('/tmp/control.sock', {
        close,
      }),
    ).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);

    chmod.mockRestore();
  });

  it('blocks session ensure for mismatched app access', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-1',
        scopes: ['sessions:write'],
        appId: 'app-one',
      },
    ]);
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    const handle = startControlServer({ app: app as any });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/ensure`,
        'token-1',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-two',
            conversationId: 'conv-1',
          }),
        },
      );
      expect(response.status).toBe(403);
      expect(app.registerGroup).not.toHaveBeenCalled();
      expect(controlRepo.ensureAppSession).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('blocks memory access for mismatched app access', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-token',
        scopes: ['memory:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory`,
        'memory-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-two',
            agentId: 'agent',
            groupId: 'group',
            key: 'preference',
            value: 'Use concise replies.',
          }),
        },
      );
      expect(response.status).toBe(403);
      expect(memoryService.save).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('passes admin authority only when memory:admin scope is present', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-admin-token',
        scopes: ['memory:write', 'memory:admin'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory`,
        'memory-admin-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            agentId: 'agent',
            subjectType: 'common',
            key: 'support-policy',
            value: 'Escalate billing requests.',
          }),
        },
      );
      expect(response.status).toBe(201);
      expect(memoryService.save).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          isAdminWrite: true,
          subjectType: 'common',
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('fails memory writes closed when runtime memory is disabled', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-disabled-token',
        scopes: ['memory:write'],
        appId: 'app-one',
      },
    ]);
    memoryService.isEnabled.mockReturnValue(false);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory`,
        'memory-disabled-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            agentId: 'agent',
            groupId: 'group',
            key: 'preference',
            value: 'Use concise replies.',
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'MEMORY_DISABLED' },
      });
      expect(memoryService.save).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('routes memory list, search, patch, delete, dreaming trigger, and status with app auth', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-all-token',
        scopes: ['memory:read', 'memory:write', 'memory:admin'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const listResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory?appId=app-one&agentId=agent&groupId=group`,
        'memory-all-token',
      );
      expect(listResponse.status).toBe(200);
      expect(memoryService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          agentId: 'agent',
          groupId: 'group',
        }),
      );

      const searchResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/search`,
        'memory-all-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            agentId: 'agent',
            groupId: 'group',
            query: 'billing',
          }),
        },
      );
      expect(searchResponse.status).toBe(200);
      expect(memoryService.search).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'app-one', query: 'billing' }),
      );

      const patchResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/mem-1`,
        'memory-all-token',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            agentId: 'agent',
            groupId: 'group',
            value: 'updated',
          }),
        },
      );
      expect(patchResponse.status).toBe(200);
      expect(memoryService.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mem-1',
          appId: 'app-one',
          isAdminWrite: true,
        }),
      );

      const deleteResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/mem-1?appId=app-one&agentId=agent&groupId=group`,
        'memory-all-token',
        { method: 'DELETE' },
      );
      expect(deleteResponse.status).toBe(200);
      expect(memoryService.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mem-1',
          appId: 'app-one',
          isAdminWrite: true,
        }),
      );

      const dreamResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/dreaming/trigger`,
        'memory-all-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: 'app-one', agentId: 'agent' }),
        },
      );
      expect(dreamResponse.status).toBe(202);
      expect(memoryService.triggerDreaming).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'app-one', agentId: 'agent' }),
      );

      const statusResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/dreaming/status?appId=app-one&agentId=agent`,
        'memory-all-token',
      );
      expect(statusResponse.status).toBe(200);
      expect(memoryService.dreamingStatus).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'app-one', agentId: 'agent' }),
      );
    } finally {
      await handle.close();
    }
  });

  it('fails patch, delete, and dreaming trigger closed when runtime memory is disabled', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-disabled-all-token',
        scopes: ['memory:write', 'memory:admin'],
        appId: 'app-one',
      },
    ]);
    memoryService.isEnabled.mockReturnValue(false);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const patchResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/mem-1`,
        'memory-disabled-all-token',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: 'app-one', value: 'updated' }),
        },
      );
      expect(patchResponse.status).toBe(409);

      const deleteResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/mem-1?appId=app-one`,
        'memory-disabled-all-token',
        { method: 'DELETE' },
      );
      expect(deleteResponse.status).toBe(409);

      const dreamResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/memory/dreaming/trigger`,
        'memory-disabled-all-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: 'app-one' }),
        },
      );
      expect(dreamResponse.status).toBe(409);
      expect(memoryService.patch).not.toHaveBeenCalled();
      expect(memoryService.delete).not.toHaveBeenCalled();
      expect(memoryService.triggerDreaming).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects unsafe session identifiers before registering app groups', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-unsafe-session',
        scopes: ['sessions:write'],
        appId: 'app-one',
      },
    ]);
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    const handle = startControlServer({ app: app as any });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/ensure`,
        'token-unsafe-session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            conversationId: 'conv:unsafe',
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(app.registerGroup).not.toHaveBeenCalled();
      expect(controlRepo.ensureAppSession).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('binds webhook registration to authenticated app id', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-2',
        scopes: ['webhooks:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/webhooks`,
        'token-2',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-two',
            name: 'webhook-name',
            url: 'https://example.com/hook',
            secret: 'secret-1',
          }),
        },
      );
      expect(response.status).toBe(201);
      expect(controlRepo.registerWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          name: 'webhook-name',
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects session ensure when webhook id is not owned by the app', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-ensure-webhook',
        scopes: ['sessions:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getWebhookById.mockResolvedValue(null);
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    const handle = startControlServer({ app: app as any });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/ensure`,
        'token-ensure-webhook',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            conversationId: 'conv-1',
            webhookId: 'foreign-webhook',
          }),
        },
      );
      expect(response.status).toBe(404);
      expect(controlRepo.getWebhookById).toHaveBeenCalledWith(
        'foreign-webhook',
        'app-one',
      );
      expect(app.registerGroup).not.toHaveBeenCalled();
      expect(controlRepo.ensureAppSession).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects session messages when webhook id is not owned by the app', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-message-webhook',
        scopes: ['sessions:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      groupFolder: 'app_app_one_conv_1',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getWebhookById.mockResolvedValue(null);
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    const handle = startControlServer({ app: app as any });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/session-1/messages`,
        'token-message-webhook',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: 'hello',
            webhookId: 'foreign-webhook',
          }),
        },
      );
      expect(response.status).toBe(404);
      expect(controlRepo.getWebhookById).toHaveBeenCalledWith(
        'foreign-webhook',
        'app-one',
      );
      expect(opsRepo.storeMessage).not.toHaveBeenCalled();
      expect(controlRepo.addControlEvent).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('persists SDK session messages, emits control events, and queues app work', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-message',
        scopes: ['sessions:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      groupFolder: 'app_app_one_conv_1',
      title: 'Conversation',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    const handle = startControlServer({ app: app as any });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/session-1/messages`,
        'token-message',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: 'hello from sdk',
            threadId: 'thread-1',
            correlationId: 'corr-1',
            responseMode: 'sse',
          }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toEqual(
        expect.objectContaining({
          accepted: true,
          messageId: expect.any(String),
          acceptedEventId: 1001,
        }),
      );
      expect(opsRepo.storeChatMetadata).toHaveBeenCalledWith(
        'app:app-one:conv-1',
        expect.any(String),
        'Conversation',
        'app',
        true,
      );
      expect(opsRepo.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: body.messageId,
          chat_jid: 'app:app-one:conv-1',
          sender: 'sdk',
          sender_name: 'SDK',
          content: 'hello from sdk',
          thread_id: 'thread-1',
        }),
      );
      expect(controlRepo.upsertAppResponseRoute).toHaveBeenCalledWith({
        sessionId: 'session-1',
        threadId: 'thread-1',
        responseMode: 'sse',
        webhookId: null,
        correlationId: 'corr-1',
      });
      expect(controlRepo.addControlEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'session.message.inbound',
          actor: 'sdk',
          sessionId: 'session-1',
          correlationId: 'corr-1',
          responseMode: 'sse',
        }),
      );
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'app:app-one:conv-1::thread:thread-1',
      );
    } finally {
      await handle.close();
    }
  });

  it('scopes webhook lookups to the authenticated app id', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-3',
        scopes: ['webhooks:write'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/webhooks/webhook-foreign/test`,
        'token-3',
        {
          method: 'POST',
        },
      );
      expect(response.status).toBe(404);
      expect(controlRepo.getWebhookById).toHaveBeenCalledWith(
        'webhook-foreign',
        'app-one',
      );
      expect(controlRepo.addControlEvent).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('scopes webhook listing to the authenticated app id', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-4',
        scopes: ['webhooks:read'],
        appId: 'app-one',
      },
    ]);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/webhooks?appId=app-two`,
        'token-4',
      );
      expect(response.status).toBe(200);
      expect(controlRepo.listWebhooks).toHaveBeenCalledWith('app-one');
    } finally {
      await handle.close();
    }
  });

  it('threads authenticated app id into webhook dead-letter replay', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-replay',
        scopes: ['webhooks:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getWebhookById.mockResolvedValue({
      webhookId: 'webhook-1',
      appId: 'app-one',
      name: 'webhook',
      url: 'https://example.com/hook',
      secret: 'secret',
      enabled: true,
    });
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/webhooks/webhook-1/replay-dead-letter`,
        'token-replay',
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(controlRepo.replayWebhookDeadLetters).toHaveBeenCalledWith(
        'webhook-1',
        'app-one',
      );
    } finally {
      await handle.close();
    }
  });

  it('threads authenticated app id into webhook dead-letter purge', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-purge',
        scopes: ['webhooks:write'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getWebhookById.mockResolvedValue({
      webhookId: 'webhook-1',
      appId: 'app-one',
      name: 'webhook',
      url: 'https://example.com/hook',
      secret: 'secret',
      enabled: true,
    });
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/webhooks/webhook-1/purge-dead-letter`,
        'token-purge',
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(controlRepo.purgeWebhookDeadLetters).toHaveBeenCalledWith(
        'webhook-1',
        'app-one',
      );
    } finally {
      await handle.close();
    }
  });

  it('delivers signed webhooks and marks delivery complete', async () => {
    process.env.MYCLAW_CONTROL_ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
    const received: Array<{ body: string; signature: string | undefined }> = [];
    const receiver = net.createServer((socket) => {
      let raw = '';
      socket.on('data', (chunk) => {
        raw += chunk.toString();
        if (!raw.includes('\r\n\r\n')) return;
        const body = raw.split('\r\n\r\n')[1] ?? '';
        const signature = /x-myclaw-webhook-signature: ([^\r\n]+)/i.exec(
          raw,
        )?.[1];
        received.push({ body, signature });
        socket.end(
          'HTTP/1.1 204 No Content\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
        );
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    const address = receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');

    try {
      await _testControlServer.deliverWebhookDelivery({
        deliveryId: 'delivery-1',
        attemptCount: 0,
        sessionAppId: 'app-one',
        webhook: {
          webhookId: 'webhook-1',
          appId: 'app-one',
          url: `http://127.0.0.1:${address.port}/hook`,
          secret: 'webhook-secret',
          enabled: true,
        },
        event: {
          eventId: 42,
          eventType: 'session.message.outbound',
          sessionId: 'session-1',
          jobId: null,
          runId: null,
          triggerId: null,
          correlationId: 'corr-1',
          createdAt: '2026-04-24T00:00:00.000Z',
          payload: JSON.stringify({ text: 'hello' }),
        },
      } as any);

      expect(received).toHaveLength(1);
      expect(received[0]?.body).toContain('"eventId":42');
      expect(received[0]?.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(controlRepo.markWebhookDeliveryDelivered).toHaveBeenCalledWith(
        'delivery-1',
      );
      expect(controlRepo.markWebhookDeliveryRetry).not.toHaveBeenCalled();
      expect(controlRepo.markWebhookDeliveryDead).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      delete process.env.MYCLAW_CONTROL_ALLOW_INSECURE_WEBHOOKS;
      delete process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
    }
  });

  it('retries retryable webhook failures and dead-letters ownership mismatches', async () => {
    await _testControlServer.deliverWebhookDelivery({
      deliveryId: 'delivery-mismatch',
      attemptCount: 0,
      sessionAppId: 'app-two',
      webhook: {
        webhookId: 'webhook-1',
        appId: 'app-one',
        url: 'https://example.com/hook',
        secret: 'webhook-secret',
        enabled: true,
      },
      event: {
        eventId: 43,
        eventType: 'session.message.outbound',
        sessionId: 'session-1',
        jobId: null,
        runId: null,
        triggerId: null,
        correlationId: null,
        createdAt: '2026-04-24T00:00:00.000Z',
        payload: JSON.stringify({ text: 'hello' }),
      },
    } as any);

    expect(controlRepo.markWebhookDeliveryDead).toHaveBeenCalledWith(
      'delivery-mismatch',
      'Webhook registration does not belong to event app',
    );

    process.env.MYCLAW_CONTROL_ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
    const receiver = net.createServer((socket) => {
      socket.on('data', () => {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
        );
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    const address = receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');

    try {
      await _testControlServer.deliverWebhookDelivery({
        deliveryId: 'delivery-retry',
        attemptCount: 1,
        sessionAppId: 'app-one',
        webhook: {
          webhookId: 'webhook-1',
          appId: 'app-one',
          url: `http://127.0.0.1:${address.port}/hook`,
          secret: 'webhook-secret',
          enabled: true,
        },
        event: {
          eventId: 44,
          eventType: 'session.message.outbound',
          sessionId: 'session-1',
          jobId: null,
          runId: null,
          triggerId: null,
          correlationId: null,
          createdAt: '2026-04-24T00:00:00.000Z',
          payload: JSON.stringify({ text: 'hello' }),
        },
      } as any);

      expect(controlRepo.markWebhookDeliveryRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'delivery-retry',
          lastError: 'Webhook request failed with status 503',
        }),
      );
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      delete process.env.MYCLAW_CONTROL_ALLOW_INSECURE_WEBHOOKS;
      delete process.env.MYCLAW_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
    }
  });
});

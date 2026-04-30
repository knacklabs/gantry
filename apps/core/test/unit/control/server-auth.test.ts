import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentChannelBindingListResponseSchema,
  AgentChannelBindingResponseSchema,
  ChannelInstallationListResponseSchema,
  ChannelInstallationResponseSchema,
  ChannelProviderListResponseSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationThreadListResponseSchema,
  MessageListResponseSchema,
} from '@myclaw/contracts';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { signExternalIngressRequest } from '@core/application/external-ingress/signature.js';

vi.mock('@core/config/index.js', async () => {
  const runtimeHome = '/tmp/myclaw-control-test-home';
  const settingsModule =
    await import('@core/config/settings/runtime-settings.js');
  const toPublic = () => {
    const settings = settingsModule.loadRuntimeSettings(runtimeHome);
    return {
      agent: {
        name: settings.agent.name,
        defaultModel: settings.agent.defaultModel,
      },
      memory: {
        enabled: settings.memory.enabled,
        dreaming: { enabled: settings.memory.dreaming.enabled },
      },
    };
  };
  return {
    MYCLAW_HOME: runtimeHome,
    getPublicRuntimeSettings: toPublic,
    updatePublicRuntimeSettings: (patch: any) => {
      const settings = settingsModule.loadRuntimeSettings(runtimeHome);
      const changed: string[] = [];
      if (patch.agent?.name !== undefined) {
        settings.agent.name = patch.agent.name.trim();
        changed.push('agent.name');
      }
      if (patch.agent?.defaultModel !== undefined) {
        settings.agent.defaultModel = patch.agent.defaultModel.trim();
        changed.push('agent.defaultModel');
      }
      if (patch.memory?.dreaming?.enabled !== undefined) {
        settings.memory.dreaming.enabled = patch.memory.dreaming.enabled;
        changed.push('memory.dreaming.enabled');
      }
      settingsModule.saveRuntimeSettings(runtimeHome, settings);
      return {
        settings: toPublic(),
        changed,
        restartRequired: changed.length > 0,
      };
    },
  };
});

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isSchedulerReady: vi.fn(() => true),
  runtimeJobSchedulePlanner: {
    createManualJobId: () => 'job-test',
    createJobId: () => 'job-test',
    planAppSchedule: () => ({
      scheduleType: 'manual',
      scheduleValue: 'manual',
      nextRun: null,
    }),
    planInitial: () => ({ nextRun: '2026-04-24T01:00:00.000Z' }),
    planResume: ({ job, clock }) =>
      job.next_run ??
      (job.schedule_type === 'manual'
        ? null
        : job.schedule_type === 'once'
          ? job.schedule_value
          : clock.now()),
  },
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
  upsertAppResponseRoute: vi.fn(async () => undefined),
  replayWebhookDeadLetters: vi.fn(async () => 0),
  purgeWebhookDeadLetters: vi.fn(async () => 0),
  markWebhookDeliveryDelivered: vi.fn(async () => undefined),
  markWebhookDeliveryRetry: vi.fn(async () => undefined),
  markWebhookDeliveryDead: vi.fn(async () => undefined),
  createExternalIngress: vi.fn(),
  listExternalIngresses: vi.fn(async () => []),
  getExternalIngressById: vi.fn(async () => ({
    ingressId: 'ingress-1',
    appId: 'app-one',
    name: 'ingress-main',
    secret: 'ingress-secret',
    enabled: true,
    metadata: {
      targetPolicy: {
        allowedTargetKinds: ['session_message', 'job_trigger'],
        conversationIds: ['conv-1'],
        sessionIds: ['session-1'],
        jobIds: ['job-1'],
      },
    },
    createdAt: '2026-04-24T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  })),
  updateExternalIngress: vi.fn(),
  deleteExternalIngress: vi.fn(async () => true),
  reserveExternalIngressNonce: vi.fn(async () => ({ ok: true as const })),
  getExternalIngressInvocationByIdempotencyKey: vi.fn(async () => undefined),
  createExternalIngressInvocation: vi.fn(async (input: any) => ({
    created: true,
    row: {
      invocationId: input.invocationId,
      status: 'pending',
      bodyHash: input.bodyHash,
      response: null,
      error: null,
      updatedAt: input.now,
    },
  })),
  updateExternalIngressInvocation: vi.fn(async () => undefined),
  getExternalIngressInvocation: vi.fn(async () => ({
    invocationId: 'invocation-1',
    status: 'completed',
    bodyHash: 'hash',
    response: { ok: true },
    error: null,
    updatedAt: '2026-04-24T00:00:00.000Z',
  })),
  sweepExpiredExternalIngressState: vi.fn(async () => ({
    noncesDeleted: 0,
    invocationsDeleted: 0,
    stalePendingFailed: 0,
  })),
};

const opsRepo = {
  storeChatMetadata: vi.fn(async () => undefined),
  storeMessage: vi.fn(async () => undefined),
  getJobRunById: vi.fn(async () => undefined),
  getJobById: vi.fn(async () => undefined),
};
const runtimeEvents = {
  publish: vi.fn(async () => ({ eventId: 1001 })),
  list: vi.fn(async () => []),
  subscribe: vi.fn(),
};

const domainRepositories = {
  agents: {
    getAgent: vi.fn(async (id: string) => ({
      id,
      appId: 'app-one',
      name: 'Agent',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
  },
  channelInstallations: {
    listChannelInstallations: vi.fn(async () => []),
    getChannelInstallation: vi.fn(async () => null),
    saveChannelInstallation: vi.fn(async () => undefined),
    updateChannelInstallation: vi.fn(async () => null),
    disableChannelInstallation: vi.fn(async () => null),
    saveAgentChannelBinding: vi.fn(async () => undefined),
    disableAgentChannelBinding: vi.fn(async () => null),
    getAgentChannelBinding: vi.fn(async () => null),
    isAgentEnabledInConversation: vi.fn(async () => false),
    listAgentChannelBindings: vi.fn(async () => []),
  },
  conversations: {
    listConversations: vi.fn(async () => []),
    getConversation: vi.fn(async () => null),
    getConversationByExternalRef: vi.fn(async () => null),
    getThread: vi.fn(async () => null),
    getThreadByExternalRef: vi.fn(async () => null),
    saveConversation: vi.fn(async () => undefined),
    saveThread: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => []),
  },
  messages: {
    listMessages: vi.fn(async () => []),
  },
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

const ingressSignatureCrypto = {
  sha256: (input: string) => createHash('sha256').update(input).digest('hex'),
  hmacSha256: (secret: string, payload: string) =>
    createHmac('sha256', secret).update(payload).digest('hex'),
  constantTimeEqual: (left: string, right: string) => {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  },
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
  getRuntimeEventExchange: () => runtimeEvents,
  getRuntimeOpsRepository: () => opsRepo,
  getRuntimeStorage: () => ({
    repositories: domainRepositories,
  }),
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
import { _testSessionRoutes } from '@core/control/server/routes/sessions.js';

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

function signIngressRequest(input: {
  ingressId: string;
  secret?: string;
  nonce?: string;
  timestamp?: string;
  path?: string;
  rawBody: string;
  method?: string;
}) {
  const method = input.method ?? 'POST';
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? 'nonce-1';
  const path = input.path ?? `/v1/ingresses/${input.ingressId}/invoke`;
  const signature = signExternalIngressRequest({
    crypto: ingressSignatureCrypto,
    secret: input.secret ?? 'ingress-secret',
    method,
    path,
    timestamp,
    nonce,
    rawBody: input.rawBody,
  }).signature;
  return { method, timestamp, nonce, signature };
}

beforeEach(() => {
  vi.clearAllMocks();
  controlRepo.listDueWebhookDeliveries.mockResolvedValue([]);
  controlRepo.claimDueWebhookDeliveries.mockResolvedValue([]);
  controlRepo.listWebhooks.mockResolvedValue([]);
  controlRepo.getWebhookById.mockResolvedValue(null);
  controlRepo.getAppSessionById.mockResolvedValue(null);
  runtimeEvents.publish.mockResolvedValue({ eventId: 1001 });
  controlRepo.upsertAppResponseRoute.mockResolvedValue(undefined);
  controlRepo.replayWebhookDeadLetters.mockResolvedValue(0);
  controlRepo.purgeWebhookDeadLetters.mockResolvedValue(0);
  controlRepo.markWebhookDeliveryDelivered.mockResolvedValue(undefined);
  controlRepo.markWebhookDeliveryRetry.mockResolvedValue(undefined);
  controlRepo.markWebhookDeliveryDead.mockResolvedValue(undefined);
  controlRepo.listExternalIngresses.mockResolvedValue([]);
  controlRepo.getExternalIngressById.mockResolvedValue({
    ingressId: 'ingress-1',
    appId: 'app-one',
    name: 'ingress-main',
    secret: 'ingress-secret',
    enabled: true,
    metadata: {
      targetPolicy: {
        allowedTargetKinds: ['session_message', 'job_trigger'],
        conversationIds: ['conv-1'],
        sessionIds: ['session-1'],
        jobIds: ['job-1'],
      },
    },
    createdAt: '2026-04-24T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  });
  controlRepo.reserveExternalIngressNonce.mockResolvedValue({ ok: true });
  controlRepo.getExternalIngressInvocationByIdempotencyKey.mockResolvedValue(
    undefined,
  );
  controlRepo.createExternalIngressInvocation.mockImplementation(
    async (input: any) => ({
      created: true,
      row: {
        invocationId: input.invocationId,
        status: 'pending',
        bodyHash: input.bodyHash,
        response: null,
        error: null,
        updatedAt: input.now,
      },
    }),
  );
  controlRepo.updateExternalIngressInvocation.mockResolvedValue(undefined);
  controlRepo.getExternalIngressInvocation.mockResolvedValue({
    invocationId: 'invocation-1',
    status: 'completed',
    bodyHash: 'hash',
    response: { ok: true },
    error: null,
    updatedAt: '2026-04-24T00:00:00.000Z',
  });
  controlRepo.sweepExpiredExternalIngressState.mockResolvedValue({
    noncesDeleted: 0,
    invocationsDeleted: 0,
    stalePendingFailed: 0,
  });
  opsRepo.storeChatMetadata.mockResolvedValue(undefined);
  opsRepo.storeMessage.mockResolvedValue(undefined);
  opsRepo.getJobRunById.mockResolvedValue(undefined);
  opsRepo.getJobById.mockResolvedValue(undefined);
  runtimeEvents.list.mockResolvedValue([]);
  runtimeEvents.subscribe.mockReset();
  domainRepositories.agents.getAgent.mockResolvedValue({
    id: 'agent-1',
    appId: 'app-one',
    name: 'Agent',
    status: 'active',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  domainRepositories.channelInstallations.listChannelInstallations.mockResolvedValue(
    [],
  );
  domainRepositories.channelInstallations.getChannelInstallation.mockResolvedValue(
    null,
  );
  domainRepositories.channelInstallations.saveChannelInstallation.mockResolvedValue(
    undefined,
  );
  domainRepositories.channelInstallations.updateChannelInstallation.mockResolvedValue(
    null,
  );
  domainRepositories.channelInstallations.disableChannelInstallation.mockResolvedValue(
    null,
  );
  domainRepositories.channelInstallations.saveAgentChannelBinding.mockResolvedValue(
    undefined,
  );
  domainRepositories.channelInstallations.disableAgentChannelBinding.mockResolvedValue(
    null,
  );
  domainRepositories.channelInstallations.getAgentChannelBinding.mockResolvedValue(
    null,
  );
  domainRepositories.channelInstallations.isAgentEnabledInConversation.mockResolvedValue(
    false,
  );
  domainRepositories.channelInstallations.listAgentChannelBindings.mockResolvedValue(
    [],
  );
  domainRepositories.conversations.listConversations.mockResolvedValue([]);
  domainRepositories.conversations.getConversation.mockResolvedValue(null);
  domainRepositories.conversations.getConversationByExternalRef.mockResolvedValue(
    null,
  );
  domainRepositories.conversations.getThread.mockResolvedValue(null);
  domainRepositories.conversations.getThreadByExternalRef.mockResolvedValue(
    null,
  );
  domainRepositories.conversations.saveConversation.mockResolvedValue(
    undefined,
  );
  domainRepositories.conversations.saveThread.mockResolvedValue(undefined);
  domainRepositories.conversations.listThreads.mockResolvedValue([]);
  domainRepositories.messages.listMessages.mockResolvedValue([]);
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
  it('serves and updates typed runtime settings', async () => {
    const runtimeHome = '/tmp/myclaw-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['sessions:read', 'agents:admin'],
        appId: 'app-one',
      },
    ]);

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
        getRuntimeSettings: () => {
          const settings = loadRuntimeSettings(runtimeHome);
          return {
            agent: {
              name: settings.agent.name,
              defaultModel: settings.agent.defaultModel,
            },
            memory: {
              enabled: settings.memory.enabled,
              dreaming: { enabled: settings.memory.dreaming.enabled },
            },
          };
        },
        updateRuntimeSettings: (patch: any) => {
          const settings = loadRuntimeSettings(runtimeHome);
          const changed: string[] = [];
          if (patch.agent?.name) {
            settings.agent.name = patch.agent.name;
            changed.push('agent.name');
          }
          if (patch.agent?.defaultModel !== undefined) {
            settings.agent.defaultModel = patch.agent.defaultModel;
            changed.push('agent.defaultModel');
          }
          if (patch.memory?.dreaming?.enabled !== undefined) {
            settings.memory.dreaming.enabled = patch.memory.dreaming.enabled;
            changed.push('memory.dreaming.enabled');
          }
          saveRuntimeSettings(runtimeHome, settings);
          return {
            settings: {
              agent: {
                name: settings.agent.name,
                defaultModel: settings.agent.defaultModel,
              },
              memory: {
                enabled: settings.memory.enabled,
                dreaming: { enabled: settings.memory.dreaming.enabled },
              },
            },
            changed,
            restartRequired: changed.length > 0,
          };
        },
      } as any,
    });
    try {
      const getResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'admin-key',
      );
      expect(getResponse.status).toBe(200);
      await expect(getResponse.json()).resolves.toMatchObject({
        settings: {
          agent: { name: 'Main Agent', defaultModel: '' },
          memory: { enabled: true, dreaming: { enabled: false } },
        },
      });

      const patchResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: { name: 'Kai', defaultModel: 'sonnet' },
            memory: { dreaming: { enabled: true } },
          }),
        },
      );
      expect(patchResponse.status).toBe(200);
      await expect(patchResponse.json()).resolves.toMatchObject({
        settings: {
          agent: { name: 'Kai', defaultModel: 'sonnet' },
          memory: { enabled: true, dreaming: { enabled: true } },
        },
        changed: [
          'agent.name',
          'agent.defaultModel',
          'memory.dreaming.enabled',
        ],
        restartRequired: true,
      });

      const raw = fs.readFileSync(
        path.join(runtimeHome, 'settings.yaml'),
        'utf-8',
      );
      expect(raw).toContain('name: Kai');
      expect(raw).toContain('default_model: sonnet');

      const unsupportedResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'admin-key',
        { method: 'POST' },
      );
      expect(unsupportedResponse.status).toBe(405);
      expect(unsupportedResponse.headers.get('allow')).toBe('GET, PATCH');
    } finally {
      await handle.close();
    }
  });

  it('rejects arbitrary runtime settings patches', async () => {
    const runtimeHome = '/tmp/myclaw-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['agents:admin'],
        appId: 'app-one',
      },
    ]);

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
        getRuntimeSettings: vi.fn(),
        updateRuntimeSettings: vi.fn(),
      } as any,
    });
    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            databaseUrl: 'postgres://secret',
          }),
        },
      );
      expect(response.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('rejects blank runtime agent names in typed settings patches', async () => {
    const runtimeHome = '/tmp/myclaw-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['agents:admin'],
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
        `http://127.0.0.1:${port}/v1/settings`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: { name: '   ' },
          }),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
        },
      });
    } finally {
      await handle.close();
    }
  });

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

  it('uses API key app scope when session ensure omits appId', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-ensure-implicit-app',
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
        'token-ensure-implicit-app',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: 'conv-implicit',
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(controlRepo.ensureAppSession).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          conversationId: 'conv-implicit',
          chatJid: 'app:app-one:conv-implicit',
        }),
      );
      expect(app.registerGroup).toHaveBeenCalledWith(
        'app:app-one:conv-implicit',
        expect.objectContaining({
          name: 'app-one:conv-implicit',
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('unblocks SSE event writes when the client closes during backpressure', async () => {
    const response = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      write: ReturnType<typeof vi.fn>;
      off: EventEmitter['off'];
      once: EventEmitter['once'];
    };
    response.destroyed = false;
    response.write = vi.fn(() => false);
    let closed = false;
    let settled = false;

    const write = _testSessionRoutes
      .writeSseEvent(
        response as never,
        {
          eventId: 1,
          appId: 'app-one',
          sessionId: 'session-1',
          eventType: 'session.message',
          payload: { ok: true },
          createdAt: '2026-04-30T00:00:00.000Z',
        },
        () => closed,
      )
      .then(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    closed = true;
    response.destroyed = true;
    response.emit('close');

    await write;
    expect(settled).toBe(true);
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
  });

  it('unblocks SSE event writes when the response errors during backpressure', async () => {
    const response = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      write: ReturnType<typeof vi.fn>;
      off: EventEmitter['off'];
      once: EventEmitter['once'];
    };
    response.destroyed = false;
    response.write = vi.fn(() => false);
    let closed = false;
    let settled = false;

    const write = _testSessionRoutes
      .writeSseEvent(
        response as never,
        {
          eventId: 2,
          appId: 'app-one',
          sessionId: 'session-1',
          eventType: 'session.message',
          payload: { ok: true },
          createdAt: '2026-04-30T00:00:00.000Z',
        },
        () => closed,
      )
      .then(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    closed = true;
    response.destroyed = true;
    response.emit('error', new Error('socket reset'));

    await write;
    expect(settled).toBe(true);
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
  });

  it('accepts signed external ingress session messages and registers before enqueue', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const app = {
      registerGroup: vi.fn(async () => undefined),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      workspaceKey: 'app_conv_1',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    const handle = startControlServer({ app: app as any });
    const path = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      target: {
        kind: 'session_message',
        conversationId: 'conv-1',
        message: 'solve captcha',
      },
      idempotencyKey: 'idem-ingress-session',
    });
    const signed = signIngressRequest({
      ingressId: 'ingress-1',
      path,
      rawBody,
      nonce: 'nonce-ingress-session',
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}${path}`,
        '',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': signed.nonce,
            'x-myclaw-ingress-signature': signed.signature,
          },
          body: rawBody,
        },
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        duplicate: false,
        targetKind: 'session_message',
        sessionId: 'session-1',
      });
      expect(app.registerGroup).toHaveBeenCalledWith(
        'app:app-one:conv-1',
        expect.objectContaining({
          name: 'app-one:conv-1',
        }),
      );
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'app:app-one:conv-1',
      );
      expect(app.registerGroup.mock.invocationCallOrder[0]).toBeLessThan(
        app.queue.enqueueMessageCheck.mock.invocationCallOrder[0],
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects missing external ingress signature headers before lookup', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/ingresses/ingress-1/invoke`,
        '',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            target: { kind: 'job_trigger', jobId: 'job-1' },
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
        },
      });
      expect(controlRepo.getExternalIngressById).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects tampered external ingress signatures before nonce reservation', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });
    const path = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      target: { kind: 'job_trigger', jobId: 'job-1' },
    });
    const signed = signIngressRequest({
      ingressId: 'ingress-1',
      path,
      rawBody,
      nonce: 'nonce-tampered',
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}${path}`,
        '',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': signed.nonce,
            'x-myclaw-ingress-signature': 'bad-signature',
          },
          body: rawBody,
        },
      );

      expect(response.status).toBe(403);
      expect(controlRepo.reserveExternalIngressNonce).not.toHaveBeenCalled();
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

  it('rejects channel routes when the token lacks channel scopes', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'sessions-only-token',
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
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/channel-providers`,
        'sessions-only-token',
      );
      expect(response.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('rejects raw channel secrets in installation config', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'channels-admin-token',
        scopes: ['channels:admin'],
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
        `http://127.0.0.1:${port}/v1/channel-installations`,
        'channels-admin-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            providerId: 'slack',
            label: 'Slack',
            config: { botToken: 'xoxb-secret' },
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(
        domainRepositories.channelInstallations.saveChannelInstallation,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects placeholder channel installation creation', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'channels-admin-token',
        scopes: ['channels:admin'],
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
        `http://127.0.0.1:${port}/v1/channel-installations`,
        'channels-admin-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            providerId: 'teams',
            label: 'Teams',
          }),
        },
      );
      expect(response.status).toBe(501);
      expect(
        domainRepositories.channelInstallations.saveChannelInstallation,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects discovery for disabled channel installations', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'channels-admin-token',
        scopes: ['channels:admin'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.channelInstallations.getChannelInstallation.mockResolvedValue(
      {
        id: 'installation-1',
        appId: 'app-one',
        providerId: 'slack',
        label: 'Slack',
        status: 'disabled',
        config: {},
        runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    );
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/channel-installations/installation-1/discover`,
        'channels-admin-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ limit: 10 }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'CONFLICT' },
      });
      expect(
        domainRepositories.conversations.getConversationByExternalRef,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('returns contract-valid channel onboarding responses', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'channel-all-token',
        scopes: [
          'channels:read',
          'channels:admin',
          'conversations:read',
          'messages:read',
          'agents:admin',
        ],
        appId: 'app-one',
      },
    ]);
    const iso = new Date(0).toISOString();
    const installation = {
      id: 'installation-1',
      appId: 'app-one',
      providerId: 'app',
      label: 'App',
      status: 'active',
      config: { workspace: 'local' },
      runtimeSecretRefs: [],
      createdAt: iso,
      updatedAt: iso,
    };
    const disabledInstallation = {
      ...installation,
      status: 'disabled',
      updatedAt: '2026-04-27T00:00:01.000Z',
    };
    const updatedInstallation = {
      ...installation,
      label: 'App workspace',
      updatedAt: '2026-04-27T00:00:02.000Z',
    };
    const conversation = {
      id: 'conversation-1',
      appId: 'app-one',
      channelInstallationId: 'installation-1',
      externalRef: { kind: 'conversation', value: 'app-conv-1' },
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const thread = {
      id: 'thread-1',
      appId: 'app-one',
      conversationId: 'conversation-1',
      externalRef: { kind: 'conversation_thread', value: 'thread-1' },
      title: 'deploy',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const message = {
      id: 'message-1',
      appId: 'app-one',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      direction: 'inbound',
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: iso,
      parts: [{ kind: 'text', text: 'hello' }],
      attachments: [],
    };
    const disabledBinding = {
      id: 'binding-1',
      appId: 'app-one',
      agentId: 'agent-1',
      channelInstallationId: 'installation-1',
      conversationId: 'conversation-1',
      displayName: 'engineering',
      status: 'disabled',
      triggerMode: 'mention',
      requiresTrigger: true,
      isAdminBinding: false,
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId: 'app-one',
        conversationId: 'conversation-1',
      },
      permissionPolicyIds: ['policy-1'],
      createdAt: iso,
      updatedAt: iso,
    };

    domainRepositories.channelInstallations.listChannelInstallations.mockResolvedValue(
      [installation],
    );
    domainRepositories.channelInstallations.getChannelInstallation.mockResolvedValue(
      installation,
    );
    domainRepositories.channelInstallations.updateChannelInstallation.mockResolvedValue(
      updatedInstallation,
    );
    domainRepositories.channelInstallations.disableChannelInstallation.mockResolvedValue(
      disabledInstallation,
    );
    domainRepositories.conversations.listConversations.mockResolvedValue([
      conversation,
    ]);
    domainRepositories.conversations.getConversation.mockResolvedValue(
      conversation,
    );
    domainRepositories.conversations.getThread.mockResolvedValue(thread);
    domainRepositories.conversations.listThreads.mockResolvedValue([thread]);
    domainRepositories.messages.listMessages.mockResolvedValue([message]);
    domainRepositories.channelInstallations.listAgentChannelBindings.mockResolvedValue(
      [disabledBinding],
    );
    domainRepositories.channelInstallations.getAgentChannelBinding.mockResolvedValue(
      disabledBinding,
    );
    domainRepositories.channelInstallations.disableAgentChannelBinding.mockResolvedValue(
      disabledBinding,
    );

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    async function jsonFor(
      path: string,
      init?: RequestInit,
      expectedStatus = 200,
    ) {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}${path}`,
        'channel-all-token',
        init,
      );
      expect(response.status).toBe(expectedStatus);
      return await response.json();
    }

    try {
      expect(
        ChannelProviderListResponseSchema.parse(
          await jsonFor('/v1/channel-providers'),
        ).providers.map((provider) => provider.id),
      ).toEqual(expect.arrayContaining(['app', 'teams', 'whatsapp']));

      ChannelInstallationListResponseSchema.parse(
        await jsonFor('/v1/channel-installations'),
      );
      ChannelInstallationResponseSchema.parse(
        await jsonFor(
          '/v1/channel-installations',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              appId: 'app-one',
              providerId: 'app',
              label: 'App',
              config: { workspace: 'local' },
            }),
          },
          201,
        ),
      );
      ChannelInstallationResponseSchema.parse(
        await jsonFor('/v1/channel-installations/installation-1'),
      );
      ChannelInstallationResponseSchema.parse(
        await jsonFor('/v1/channel-installations/installation-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'App workspace' }),
        }),
      );
      expect(
        ChannelInstallationResponseSchema.parse(
          (
            await jsonFor('/v1/channel-installations/installation-1', {
              method: 'DELETE',
            })
          ).installation,
        ).status,
      ).toBe('disabled');
      ConversationListResponseSchema.parse(
        await jsonFor('/v1/channel-installations/installation-1/discover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ limit: 10 }),
        }),
      );

      ConversationListResponseSchema.parse(
        await jsonFor('/v1/conversations?channelInstallationId=installation-1'),
      );
      ConversationResponseSchema.parse(
        await jsonFor('/v1/conversations/conversation-1'),
      );
      ConversationThreadListResponseSchema.parse(
        await jsonFor('/v1/conversations/conversation-1/threads'),
      );
      MessageListResponseSchema.parse(
        await jsonFor(
          '/v1/conversations/conversation-1/messages?threadId=thread-1&after=message-0&limit=10',
        ),
      );
      expect(domainRepositories.messages.listMessages).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        threadId: 'thread-1',
        after: 'message-0',
        limit: 10,
      });

      AgentChannelBindingListResponseSchema.parse(
        await jsonFor('/v1/agents/agent-1/channel-bindings'),
      );
      expect(
        AgentChannelBindingResponseSchema.parse(
          await jsonFor('/v1/agents/agent-1/channel-bindings/conversation-1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              triggerMode: 'mention',
              memoryScope: 'conversation',
            }),
          }),
        ).status,
      ).toBe('active');
      expect(
        AgentChannelBindingResponseSchema.parse(
          await jsonFor('/v1/agents/agent-1/channel-bindings/conversation-1', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName: 'Engineering Bot' }),
          }),
        ).status,
      ).toBe('disabled');
      expect(
        AgentChannelBindingResponseSchema.parse(
          (
            await jsonFor(
              '/v1/agents/agent-1/channel-bindings/conversation-1',
              {
                method: 'DELETE',
              },
            )
          ).binding,
        ).permissionPolicyIds,
      ).toEqual(['policy-1']);
    } finally {
      await handle.close();
    }
  });

  it.each([
    {
      name: 'channels:admin',
      path: '/v1/channel-installations',
      tokenScopes: ['channels:read'],
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appId: 'app-one',
          providerId: 'app',
          label: 'App',
        }),
      },
    },
    {
      name: 'conversations:read',
      path: '/v1/conversations',
      tokenScopes: ['channels:read'],
    },
    {
      name: 'messages:read',
      path: '/v1/conversations/conversation-1/messages',
      tokenScopes: ['conversations:read'],
    },
    {
      name: 'channels:read for binding list',
      path: '/v1/agents/agent-1/channel-bindings',
      tokenScopes: ['agents:admin'],
    },
    {
      name: 'agents:admin',
      path: '/v1/agents/agent-1/channel-bindings/conversation-1',
      tokenScopes: ['channels:read'],
      init: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ triggerMode: 'mention' }),
      },
    },
  ])(
    'rejects route group without $name scope',
    async ({ path, tokenScopes, init }) => {
      const port = await reservePort();
      process.env.MYCLAW_CONTROL_PORT = String(port);
      process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
        {
          kid: 'k',
          token: 'insufficient-scope-token',
          scopes: tokenScopes,
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
          `http://127.0.0.1:${port}${path}`,
          'insufficient-scope-token',
          init,
        );
        expect(response.status).toBe(401);
      } finally {
        await handle.close();
      }
    },
  );

  it('lists conversation messages with messages:read scope', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'messages-token',
        scopes: ['messages:read'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation-1',
      appId: 'app-one',
      channelInstallationId: 'installation-1',
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    domainRepositories.messages.listMessages.mockResolvedValue([
      {
        id: 'message-1',
        appId: 'app-one',
        conversationId: 'conversation-1',
        direction: 'inbound',
        senderDisplayName: 'Ravi',
        trust: 'trusted',
        createdAt: new Date(0).toISOString(),
        parts: [{ kind: 'text', text: 'hello' }],
        attachments: [],
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
        `http://127.0.0.1:${port}/v1/conversations/conversation-1/messages?limit=10`,
        'messages-token',
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        messages: [
          { id: 'message-1', parts: [{ payload: { text: 'hello' } }] },
        ],
      });
    } finally {
      await handle.close();
    }
  });

  it('enables and disables an agent channel binding through repository state', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'agents-admin-token',
        scopes: ['agents:admin'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation-1',
      appId: 'app-one',
      channelInstallationId: 'installation-1',
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    domainRepositories.channelInstallations.getChannelInstallation.mockResolvedValue(
      {
        id: 'installation-1',
        appId: 'app-one',
        providerId: 'slack',
        label: 'Slack',
        status: 'active',
        config: {},
        runtimeSecretRefs: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    );
    domainRepositories.channelInstallations.disableAgentChannelBinding.mockResolvedValue(
      {
        id: 'binding-1',
        appId: 'app-one',
        agentId: 'agent-1',
        channelInstallationId: 'installation-1',
        conversationId: 'conversation-1',
        displayName: 'engineering',
        status: 'disabled',
        triggerMode: 'mention',
        requiresTrigger: true,
        isAdminBinding: false,
        memoryScope: 'conversation',
        memorySubject: {
          kind: 'conversation',
          appId: 'app-one',
          conversationId: 'conversation-1',
        },
        permissionPolicyIds: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    );
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const enableResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/channel-bindings/conversation-1`,
        'agents-admin-token',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            triggerMode: 'mention',
            memoryScope: 'conversation',
          }),
        },
      );
      expect(enableResponse.status).toBe(200);
      expect(
        domainRepositories.channelInstallations.saveAgentChannelBinding,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          status: 'active',
          triggerMode: 'mention',
          memoryScope: 'conversation',
        }),
      );

      const disableResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/channel-bindings/conversation-1`,
        'agents-admin-token',
        { method: 'DELETE' },
      );
      expect(disableResponse.status).toBe(200);
      expect(
        domainRepositories.channelInstallations.disableAgentChannelBinding,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          conversationId: 'conversation-1',
        }),
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects invalid or missing agent channel binding updates', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'agents-admin-token',
        scopes: ['agents:admin'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation-1',
      appId: 'app-one',
      channelInstallationId: 'installation-1',
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    domainRepositories.channelInstallations.getChannelInstallation.mockResolvedValue(
      {
        id: 'installation-1',
        appId: 'app-one',
        providerId: 'slack',
        label: 'Slack',
        status: 'active',
        config: {},
        runtimeSecretRefs: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    );
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const missingPatch = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/channel-bindings/conversation-1`,
        'agents-admin-token',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: 'Engineering Bot' }),
        },
      );
      expect(missingPatch.status).toBe(404);

      const missingDelete = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/channel-bindings/conversation-1`,
        'agents-admin-token',
        { method: 'DELETE' },
      );
      expect(missingDelete.status).toBe(404);

      const missingUserSubject = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/channel-bindings/conversation-1`,
        'agents-admin-token',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memoryScope: 'user' }),
        },
      );
      expect(missingUserSubject.status).toBe(400);
      expect(
        domainRepositories.channelInstallations.saveAgentChannelBinding,
      ).not.toHaveBeenCalled();
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
      expect(runtimeEvents.publish).not.toHaveBeenCalled();
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
      expect(runtimeEvents.publish).toHaveBeenCalledWith(
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

  it('waits over the full session cursor while returning only visible events', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-wait',
        scopes: ['sessions:read'],
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
    const subscription = {
      next: vi.fn(async () => [
        {
          eventId: 10,
          appId: 'app-one',
          sessionId: 'session-1',
          eventType: 'session.progress',
          payload: { stage: 'thinking' },
          createdAt: new Date(10).toISOString(),
        },
        {
          eventId: 11,
          appId: 'app-one',
          sessionId: 'session-1',
          eventType: 'session.message.outbound',
          payload: { text: 'done' },
          createdAt: new Date(11).toISOString(),
        },
        {
          eventId: 12,
          appId: 'app-one',
          sessionId: 'session-1',
          eventType: 'session.typing',
          payload: { typing: false },
          createdAt: new Date(12).toISOString(),
        },
      ]),
      close: vi.fn(),
    };
    runtimeEvents.subscribe.mockReturnValue(subscription);
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/session-1/wait?afterEventId=9&timeoutMs=1000`,
        'token-wait',
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        eventId: 11,
        eventType: 'session.message.outbound',
        payload: { text: 'done' },
        afterEventId: 11,
      });
      expect(runtimeEvents.subscribe).toHaveBeenCalledWith(
        expect.not.objectContaining({ eventTypes: expect.anything() }),
      );
      expect(subscription.close).toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects signed wait requests with missing required signature headers before ingress lookup', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/ingresses/ingress-1/wait`,
        'token-any',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invocationId: 'invocation-1' }),
        },
      );
      expect(response.status).toBe(400);
      expect(controlRepo.getExternalIngressById).not.toHaveBeenCalled();
      expect(controlRepo.reserveExternalIngressNonce).not.toHaveBeenCalled();
      expect(controlRepo.getExternalIngressInvocation).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects ingress invokes for disabled ingresses', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    controlRepo.getExternalIngressById.mockResolvedValue({
      ingressId: 'ingress-1',
      appId: 'app-one',
      name: 'ingress-main',
      secret: 'ingress-secret',
      enabled: false,
      metadata: {},
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
    });
    const pathName = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      target: { kind: 'session_message', sessionId: 'session-1', message: 'x' },
    });
    const signed = signIngressRequest({
      ingressId: 'ingress-1',
      path: pathName,
      rawBody,
    });
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: signed.method,
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': signed.nonce,
            'x-myclaw-ingress-signature': signed.signature,
          },
          body: rawBody,
        },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'FORBIDDEN', message: 'Ingress is disabled' },
      });
      expect(controlRepo.reserveExternalIngressNonce).not.toHaveBeenCalled();
      expect(
        controlRepo.createExternalIngressInvocation,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects stale or malformed ingress signatures', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const pathName = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      target: { kind: 'session_message', sessionId: 'session-1', message: 'x' },
    });
    const stale = signIngressRequest({
      ingressId: 'ingress-1',
      path: pathName,
      rawBody,
      timestamp: String(Date.now() - 10 * 60_000),
      nonce: 'nonce-stale',
    });
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const staleResponse = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: stale.method,
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': stale.timestamp,
            'x-myclaw-ingress-nonce': stale.nonce,
            'x-myclaw-ingress-signature': stale.signature,
          },
          body: rawBody,
        },
      );
      expect(staleResponse.status).toBe(403);
      await expect(staleResponse.json()).resolves.toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid external ingress signature',
        },
      });
      expect(controlRepo.reserveExternalIngressNonce).not.toHaveBeenCalled();

      const badResponse = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': String(Date.now()),
            'x-myclaw-ingress-nonce': 'nonce-bad-sig',
            'x-myclaw-ingress-signature': 'bad-signature',
          },
          body: rawBody,
        },
      );
      expect(badResponse.status).toBe(403);
      await expect(badResponse.json()).resolves.toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid external ingress signature',
        },
      });
      expect(controlRepo.reserveExternalIngressNonce).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('returns conflict for nonce replays and duplicate active invocations', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const pathName = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      idempotencyKey: 'idem-conflict',
      target: { kind: 'session_message', sessionId: 'session-1', message: 'x' },
    });
    const signed = signIngressRequest({
      ingressId: 'ingress-1',
      path: pathName,
      rawBody,
      nonce: 'nonce-conflict',
    });
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      controlRepo.reserveExternalIngressNonce.mockResolvedValueOnce({
        ok: false,
        code: 'NONCE_REPLAY',
      });
      const nonceReplayResponse = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: signed.method,
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': signed.nonce,
            'x-myclaw-ingress-signature': signed.signature,
          },
          body: rawBody,
        },
      );
      expect(nonceReplayResponse.status).toBe(409);
      await expect(nonceReplayResponse.json()).resolves.toMatchObject({
        error: { code: 'CONFLICT', message: 'External ingress nonce replay' },
      });
      expect(
        controlRepo.createExternalIngressInvocation,
      ).not.toHaveBeenCalled();

      controlRepo.getExternalIngressInvocationByIdempotencyKey.mockResolvedValueOnce(
        {
          invocationId: 'invocation-active',
          status: 'pending',
          bodyHash: ingressSignatureCrypto.sha256(rawBody),
          response: null,
          error: null,
          updatedAt: '2026-04-24T00:00:00.000Z',
        },
      );
      const duplicatePendingResponse = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: signed.method,
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': 'nonce-duplicate-active',
            'x-myclaw-ingress-signature': signIngressRequest({
              ingressId: 'ingress-1',
              path: pathName,
              rawBody,
              nonce: 'nonce-duplicate-active',
              timestamp: signed.timestamp,
            }).signature,
          },
          body: rawBody,
        },
      );
      expect(duplicatePendingResponse.status).toBe(409);
      await expect(duplicatePendingResponse.json()).resolves.toMatchObject({
        error: {
          code: 'CONFLICT',
          message: 'Duplicate active external ingress invocation',
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('reuses prior invocation for exact retries with same nonce and idempotency key', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
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
    const pathName = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      idempotencyKey: 'idem-exact-retry',
      target: { kind: 'session_message', sessionId: 'session-1', message: 'x' },
    });
    const signed = signIngressRequest({
      ingressId: 'ingress-1',
      path: pathName,
      rawBody,
      nonce: 'nonce-exact-retry',
    });
    controlRepo.reserveExternalIngressNonce
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: 'NONCE_REPLAY' });
    controlRepo.getExternalIngressInvocationByIdempotencyKey
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        invocationId: 'invocation-first',
        status: 'completed',
        bodyHash: ingressSignatureCrypto.sha256(rawBody),
        response: {
          targetKind: 'session_message',
          sessionId: 'session-1',
        },
        error: null,
        updatedAt: '2026-04-24T00:00:01.000Z',
      });
    controlRepo.createExternalIngressInvocation.mockResolvedValueOnce({
      created: true,
      row: {
        invocationId: 'invocation-first',
        status: 'pending',
        bodyHash: ingressSignatureCrypto.sha256(rawBody),
        response: null,
        error: null,
        updatedAt: '2026-04-24T00:00:00.000Z',
      },
    });
    const handle = startControlServer({ app: app as any });

    try {
      const first = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: signed.method,
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': signed.nonce,
            'x-myclaw-ingress-signature': signed.signature,
          },
          body: rawBody,
        },
      );
      expect(first.status).toBe(202);

      const second = await requestWithRetry(
        `http://127.0.0.1:${port}${pathName}`,
        'token-any',
        {
          method: signed.method,
          headers: {
            'content-type': 'application/json',
            'x-myclaw-ingress-timestamp': signed.timestamp,
            'x-myclaw-ingress-nonce': signed.nonce,
            'x-myclaw-ingress-signature': signed.signature,
          },
          body: rawBody,
        },
      );
      expect(second.status).toBe(202);
      await expect(second.json()).resolves.toMatchObject({
        invocationId: 'invocation-first',
        duplicate: true,
      });
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('lists run events using the authenticated app scope', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-run-events',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    opsRepo.getJobRunById.mockResolvedValue({
      run_id: 'run-1',
      job_id: 'job-1',
      scheduled_for: new Date(0).toISOString(),
      started_at: new Date(0).toISOString(),
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    opsRepo.getJobById.mockResolvedValue({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run this',
      model: null,
      script: null,
      schedule_type: 'manual',
      schedule_value: 'manual',
      status: 'active',
      linked_sessions: ['app:app-two:conv-2', 'app:app-one:conv-1'],
      session_id: null,
      thread_id: null,
      group_scope: 'app_app_one_conv_1',
      created_by: 'human',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      next_run: null,
      last_run: null,
      execution_mode: 'parallel',
      lease_run_id: null,
      lease_expires_at: null,
      consecutive_failures: 0,
      max_retries: 3,
      retry_backoff_ms: 1000,
    });
    runtimeEvents.list.mockResolvedValue([
      {
        eventId: 501,
        appId: 'app-one',
        runId: 'run-1',
        eventType: 'job.streaming',
        payload: { text: 'chunk' },
        createdAt: new Date(0).toISOString(),
      },
      {
        eventId: 502,
        appId: 'app-one',
        runId: 'run-1',
        eventType: 'run.completed',
        payload: { summary: 'done' },
        createdAt: new Date(1).toISOString(),
      },
    ]);
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/runs/run-1/events`,
        'token-run-events',
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        events: [
          {
            id: '501',
            appId: 'app-one',
            runId: 'run-1',
            type: 'output_chunk',
            metadata: { runtimeEventType: 'job.streaming' },
          },
          {
            id: '502',
            appId: 'app-one',
            runId: 'run-1',
            type: 'completed',
            metadata: { runtimeEventType: 'run.completed' },
          },
        ],
      });
      expect(runtimeEvents.list).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          runId: 'run-1',
        }),
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
      expect(runtimeEvents.publish).not.toHaveBeenCalled();
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
        eventAppId: 'app-one',
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
      eventAppId: 'app-two',
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
        eventAppId: 'app-one',
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

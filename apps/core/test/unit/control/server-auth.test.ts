import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConversationBindingListResponseSchema,
  AgentConversationBindingResponseSchema,
  ProviderConnectionListResponseSchema,
  ProviderConnectionResponseSchema,
  ProviderListResponseSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationThreadListResponseSchema,
  MessageListResponseSchema,
} from '@gantry/contracts';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { getControlEnvValue } from '@core/config/index.js';
import { signExternalIngressRequest } from '@core/application/external-ingress/signature.js';
import { preflightModelPreset } from '@core/adapters/llm/model-preset-preflight.js';

vi.mock('@core/adapters/llm/model-preset-preflight.js', () => ({
  preflightModelPreset: vi.fn(async () => ({
    ok: true,
    status: 'pass',
    message: 'OpenRouter Model Access credential is available.',
  })),
}));

const mockedPreflightModelPreset = vi.mocked(preflightModelPreset);
const mockedGetControlEnvValue = vi.mocked(getControlEnvValue);

vi.mock('@core/config/index.js', async () => {
  const runtimeHome = '/tmp/gantry-control-test-home';
  const settingsModule =
    await import('@core/config/settings/runtime-settings.js');
  const modelDefaultsModule =
    await import('@core/config/settings/model-defaults.js');
  const yoloPolicy = await import('@core/shared/yolo-mode-policy.js');
  const toPublic = () => {
    const settings = settingsModule.loadRuntimeSettings(runtimeHome);
    return {
      agent: {
        name: settings.agent.name,
        defaultModel: settings.agent.defaultModel,
        oneTimeJobDefaultModel: settings.agent.oneTimeJobDefaultModel,
        recurringJobDefaultModel: settings.agent.recurringJobDefaultModel,
      },
      memory: {
        enabled: settings.memory.enabled,
        dreaming: { enabled: settings.memory.dreaming.enabled },
      },
      permissions: {
        yoloMode: yoloPolicy.effectiveYoloModeSettings(
          settings.permissions.yoloMode,
        ),
        egress: settings.permissions.egress,
      },
    };
  };
  const getDefaultModelConfig = (kind = 'interactive') => {
    const settings = settingsModule.loadRuntimeSettings(runtimeHome);
    if (kind === 'oneTimeJob' && settings.agent.oneTimeJobDefaultModel) {
      return {
        model: settings.agent.oneTimeJobDefaultModel,
        source: 'settings.yaml agent.one_time_job_default_model',
      };
    }
    if (kind === 'recurringJob' && settings.agent.recurringJobDefaultModel) {
      return {
        model: settings.agent.recurringJobDefaultModel,
        source: 'settings.yaml agent.recurring_job_default_model',
      };
    }
    return {
      model: settings.agent.defaultModel || 'opus',
      source: settings.agent.defaultModel
        ? 'settings.yaml agent.default_model'
        : 'system default',
    };
  };
  return {
    GANTRY_HOME: runtimeHome,
    getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
    envValueDynamic: vi.fn((key: string) => process.env[key]?.trim() || ''),
    syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
    getDefaultModelConfig: vi.fn(getDefaultModelConfig),
    getRuntimeModelDefaults: vi.fn(() =>
      modelDefaultsModule.readRuntimeModelDefaults({
        runtimeHome,
        getDefaultModelConfig,
      }),
    ),
    patchRuntimeModelDefaults: vi.fn((body: Record<string, unknown>) =>
      modelDefaultsModule.updateRuntimeModelDefaults({
        runtimeHome,
        body,
      }),
    ),
    getRuntimeSettingsForConfig: vi.fn(() =>
      settingsModule.loadRuntimeSettings(runtimeHome),
    ),
    getSelectedAgentHarness: vi.fn((agentFolder?: string) => {
      const settings = settingsModule.loadRuntimeSettings(runtimeHome);
      return (
        (agentFolder
          ? settings.agents?.[agentFolder]?.agentHarness
          : undefined) ??
        settings.agent.agentHarness ??
        'auto'
      );
    }),
    getPublicRuntimeSettings: toPublic,
    configureDesiredSettingsStorageProvider: vi.fn(() => undefined),
  };
});

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isJobTriggerQueueReady: vi.fn(() => true),
  isSchedulerReady: vi.fn(() => true),
  schedulerNotReadyReason: () => undefined,
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
    workspaceKey: input.workspaceFolder,
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
  getAppSessionsByIds: vi.fn(async () => []),
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
  getAllConversationRoutes: vi.fn(async () => ({})),
  storeChatMetadata: vi.fn(async () => undefined),
  storeMessage: vi.fn(async () => undefined),
  getJobRunById: vi.fn(async () => undefined),
  getJobById: vi.fn(async () => undefined),
  listJobs: vi.fn(async () => []),
  listJobRuns: vi.fn(async () => []),
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
    listAgents: vi.fn(async () => []),
    saveAgent: vi.fn(async () => undefined),
    replaceAgentCapabilityBindings: vi.fn(async () => undefined),
  },
  providerConnections: {
    listProviderConnections: vi.fn(async () => []),
    getProviderConnection: vi.fn(async () => null),
    saveProviderConnection: vi.fn(async () => undefined),
    updateProviderConnection: vi.fn(async () => null),
    disableProviderConnection: vi.fn(async () => null),
    saveAgentConversationBinding: vi.fn(async () => undefined),
    disableAgentConversationBinding: vi.fn(async () => null),
    getAgentConversationBinding: vi.fn(async () => null),
    isAgentEnabledInConversation: vi.fn(async () => false),
    listAgentConversationBindings: vi.fn(async () => []),
    listAgentConversationBindingsByConversation: vi.fn(async () => []),
  },
  conversations: {
    listConversations: vi.fn(async () => []),
    getConversation: vi.fn(async () => null),
    getConversationByExternalRef: vi.fn(async () => null),
    findConversationByExternalValue: vi.fn(async () => null),
    getThread: vi.fn(async () => null),
    getThreadByExternalRef: vi.fn(async () => null),
    saveConversation: vi.fn(async () => undefined),
    saveThread: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => []),
    listParticipantExternalUserIds: vi.fn(async () => []),
    listConversationApprovers: vi.fn(async () => []),
    listConversationApproversForConversations: vi.fn(async () => []),
    replaceConversationApprovers: vi.fn(async () => []),
  },
  tools: {
    getTool: vi.fn(async () => null),
    listTools: vi.fn(async () => []),
    listAgentToolBindings: vi.fn(async () => []),
    listAgentToolBindingsForAgents: vi.fn(async () => []),
  },
  skills: {
    getSkill: vi.fn(async () => null),
    listAgentSkillBindings: vi.fn(async () => []),
    listAgentSkillBindingsForAgents: vi.fn(async () => []),
  },
  mcpServers: {
    getServer: vi.fn(async () => null),
    listAgentBindings: vi.fn(async () => []),
    listAgentBindingsForAgents: vi.fn(async () => []),
  },
  messages: {
    listMessages: vi.fn(async () => []),
  },
};

const memoryService = {
  isEnabled: vi.fn(() => true),
  db: {},
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
  getRuntimeRepositories: () => opsRepo,
  getRuntimeStorage: () => ({
    ops: opsRepo,
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
  mockedGetControlEnvValue.mockImplementation(
    (key: string) => process.env[key]?.trim() || '',
  );
  mockedPreflightModelPreset.mockResolvedValue({
    ok: true,
    status: 'pass',
    message: 'OpenRouter Model Access credential is available.',
  });
  controlRepo.listDueWebhookDeliveries.mockResolvedValue([]);
  controlRepo.claimDueWebhookDeliveries.mockResolvedValue([]);
  controlRepo.listWebhooks.mockResolvedValue([]);
  controlRepo.getWebhookById.mockResolvedValue(null);
  controlRepo.getAppSessionById.mockResolvedValue(null);
  controlRepo.getAppSessionsByIds.mockResolvedValue([]);
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
  opsRepo.getAllConversationRoutes.mockResolvedValue({});
  opsRepo.storeMessage.mockResolvedValue(undefined);
  opsRepo.getJobRunById.mockResolvedValue(undefined);
  opsRepo.getJobById.mockResolvedValue(undefined);
  opsRepo.listJobs.mockResolvedValue([]);
  opsRepo.listJobRuns.mockResolvedValue([]);
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
  domainRepositories.agents.listAgents.mockResolvedValue([]);
  domainRepositories.agents.saveAgent.mockResolvedValue(undefined);
  domainRepositories.agents.replaceAgentCapabilityBindings.mockResolvedValue(
    undefined,
  );
  domainRepositories.providerConnections.listProviderConnections.mockResolvedValue(
    [],
  );
  domainRepositories.providerConnections.getProviderConnection.mockResolvedValue(
    null,
  );
  domainRepositories.providerConnections.saveProviderConnection.mockResolvedValue(
    undefined,
  );
  domainRepositories.providerConnections.updateProviderConnection.mockResolvedValue(
    null,
  );
  domainRepositories.providerConnections.disableProviderConnection.mockResolvedValue(
    null,
  );
  domainRepositories.providerConnections.saveAgentConversationBinding.mockResolvedValue(
    undefined,
  );
  domainRepositories.providerConnections.disableAgentConversationBinding.mockResolvedValue(
    null,
  );
  domainRepositories.providerConnections.getAgentConversationBinding.mockResolvedValue(
    null,
  );
  domainRepositories.providerConnections.isAgentEnabledInConversation.mockResolvedValue(
    false,
  );
  domainRepositories.providerConnections.listAgentConversationBindings.mockResolvedValue(
    [],
  );
  domainRepositories.providerConnections.listAgentConversationBindingsByConversation.mockResolvedValue(
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
  domainRepositories.conversations.listParticipantExternalUserIds.mockResolvedValue(
    [],
  );
  domainRepositories.conversations.listConversationApprovers.mockResolvedValue(
    [],
  );
  domainRepositories.conversations.listConversationApproversForConversations.mockResolvedValue(
    [],
  );
  domainRepositories.conversations.replaceConversationApprovers.mockResolvedValue(
    [],
  );
  domainRepositories.tools.getTool.mockResolvedValue(null);
  domainRepositories.tools.listTools.mockResolvedValue([]);
  domainRepositories.tools.listAgentToolBindings.mockResolvedValue([]);
  domainRepositories.tools.listAgentToolBindingsForAgents.mockResolvedValue([]);
  domainRepositories.skills.getSkill.mockResolvedValue(null);
  domainRepositories.skills.listAgentSkillBindings.mockResolvedValue([]);
  domainRepositories.skills.listAgentSkillBindingsForAgents.mockResolvedValue(
    [],
  );
  domainRepositories.mcpServers.getServer.mockResolvedValue(null);
  domainRepositories.mcpServers.listAgentBindings.mockResolvedValue([]);
  domainRepositories.mcpServers.listAgentBindingsForAgents.mockResolvedValue(
    [],
  );
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
  delete process.env.GANTRY_CONTROL_API_KEYS_JSON;
  delete process.env.GANTRY_CONTROL_API_KEY;
  delete process.env.GANTRY_CONTROL_APP_ID;
  delete process.env.GANTRY_CONTROL_HOST;
  delete process.env.GANTRY_CONTROL_PORT;
  delete process.env.GANTRY_CONTROL_SOCKET_PATH;
  delete process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
});

describe('control server auth key parsing', () => {
  function parseControlApiKeysFromEnv() {
    return _testControlServer.parseControlApiKeys({
      rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
    });
  }

  it('returns no keys when GANTRY_CONTROL_API_KEYS_JSON is malformed', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = '{"kid":"broken"';

    expect(parseControlApiKeysFromEnv()).toEqual([]);
  });

  it('fails strict parsing when GANTRY_CONTROL_API_KEYS_JSON is malformed', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = '{"kid":"broken"';

    expect(() =>
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
      }),
    ).toThrow('GANTRY_CONTROL_API_KEYS_JSON must be valid JSON');
  });

  it('fails strict parsing when a configured key has invalid scope data', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-bad-scope',
        appId: 'app-one',
        scopes: ['jobs:write', 'invalid:scope'],
      },
    ]);

    expect(() =>
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
      }),
    ).toThrow('unsupported scope invalid:scope');
  });

  it('fails strict parsing when a configured key uses obsolete memory write scope', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-obsolete-scope',
        appId: 'app-one',
        scopes: ['memory:write'],
      },
    ]);

    expect(() =>
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
      }),
    ).toThrow('unsupported scope memory:write');
  });

  it('fails strict parsing when configured keys reuse a key id', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'duplicate',
        token: 'token-a',
        appId: 'app-one',
        scopes: ['sessions:read'],
      },
      {
        kid: 'duplicate',
        token: 'token-b',
        appId: 'app-one',
        scopes: ['jobs:read'],
      },
    ]);

    expect(() =>
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
      }),
    ).toThrow('kid duplicates another key');
  });

  it('enforces stronger tokens and non-empty scopes when requested', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'short-token',
        appId: 'app-one',
        scopes: ['sessions:read'],
      },
    ]);

    expect(() =>
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
        requireStrongTokens: true,
      }),
    ).toThrow('token must be at least 32 characters');

    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'x'.repeat(32),
        appId: 'app-one',
        scopes: [],
      },
    ]);

    expect(() =>
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
        requireNonEmptyScopes: true,
      }),
    ).toThrow('scopes must include at least one scope');
  });

  it('filters out JSON keys that are not app-bound', () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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

    const keys = parseControlApiKeysFromEnv();

    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe('valid');
    expect(keys[0]?.appId).toBe('app-one');
  });

  it('ignores legacy single-token auth even when an app id is present', () => {
    process.env.GANTRY_CONTROL_API_KEY = 'single-token';
    expect(parseControlApiKeysFromEnv()).toHaveLength(0);

    process.env.GANTRY_CONTROL_APP_ID = 'app:unsafe';
    expect(parseControlApiKeysFromEnv()).toHaveLength(0);

    process.env.GANTRY_CONTROL_APP_ID = 'app-two';
    expect(parseControlApiKeysFromEnv()).toHaveLength(0);
  });

  it('strict parsing ignores legacy single-token auth', () => {
    process.env.GANTRY_CONTROL_API_KEY = 'single-token';

    expect(
      _testControlServer.parseControlApiKeysStrict({
        rawJson: process.env.GANTRY_CONTROL_API_KEYS_JSON,
      }),
    ).toEqual([]);
  });

  it('defaults TCP control binding to loopback unless explicitly configured', () => {
    expect(_testControlServer.resolveControlHost()).toBe('127.0.0.1');

    process.env.GANTRY_CONTROL_HOST = '0.0.0.0';

    expect(_testControlServer.resolveControlHost()).toBe('0.0.0.0');
  });

  it('rejects legacy single-token auth on protected control routes', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEY = 'single-token';
    process.env.GANTRY_CONTROL_APP_ID = 'app-one';
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents`,
        'single-token',
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid API key',
        },
      });
    } finally {
      await handle.close();
    }
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

  it('classifies routine control client disconnect errors', () => {
    expect(
      _testControlServer.isControlClientDisconnectError(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      ),
    ).toBe(true);
    expect(
      _testControlServer.isControlClientDisconnectError(
        Object.assign(new Error('pipe closed'), { code: 'EPIPE' }),
      ),
    ).toBe(true);
    expect(
      _testControlServer.isControlClientDisconnectError(
        Object.assign(new Error('closed'), {
          code: 'ERR_STREAM_PREMATURE_CLOSE',
        }),
      ),
    ).toBe(true);
    expect(
      _testControlServer.isControlClientDisconnectError(
        Object.assign(new Error('bad request'), { code: 'HPE_INVALID_METHOD' }),
      ),
    ).toBe(false);
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

  it('keeps app workspace folders collision-resistant for distinct valid ids', () => {
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

  it('keeps app workspace hash suffix non-truncatable for max-length ids', () => {
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
  it('uses runtime config env for production posture before starting', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key-0123456789abcdef0123456789',
        scopes: ['sessions:read'],
        appId: 'app-one',
      },
    ]);
    mockedGetControlEnvValue.mockImplementation((key: string) => {
      if (key === 'GANTRY_RUNTIME_ENV') return 'production';
      return process.env[key]?.trim() || '';
    });

    expect(() =>
      startControlServer({
        app: {
          registerGroup: vi.fn(),
          queue: { enqueueMessageCheck: vi.fn() },
        } as any,
      }),
    ).toThrow('Production security preflight failed.');
    expect(mockedGetControlEnvValue).toHaveBeenCalledWith('GANTRY_RUNTIME_ENV');
  });

  it('serves typed runtime settings to agents admins but keeps them read-only', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['sessions:read', 'agents:admin'],
        appId: 'app-one',
      },
      {
        kid: 'read',
        token: 'read-key',
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
      const readOnlyResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'read-key',
      );
      expect(readOnlyResponse.status).toBe(403);

      const getResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'admin-key',
      );
      expect(getResponse.status).toBe(200);
      await expect(getResponse.json()).resolves.toMatchObject({
        settings: {
          agent: { name: 'Default Agent', defaultModel: '' },
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
            permissions: {
              yoloMode: {
                denylist: ['npm run nuke'],
              },
              egress: {
                denylist: ['api.linkedin.com'],
              },
            },
          }),
        },
      );
      expect(patchResponse.status).toBe(409);
      expect(patchResponse.headers.get('connection')).toBe('close');
      await expect(patchResponse.json()).resolves.toMatchObject({
        error: {
          code: 'SETTINGS_READ_ONLY',
        },
      });

      const raw = fs.readFileSync(
        path.join(runtimeHome, 'settings.yaml'),
        'utf-8',
      );
      expect(raw).not.toContain('npm run nuke');
      expect(raw).not.toContain('api.linkedin.com');

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

  it('serves model catalog with response family and diagnostic route metadata', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'read-key',
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
        `http://127.0.0.1:${port}/v1/models`,
        'read-key',
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: 'Kimi K2.6',
            aliases: expect.arrayContaining(['kimi', 'kimi-k2.6']),
            responseFamily: 'anthropic',
            executionRoutes: [
              {
                harness: 'deepagents',
                executionProviderId: 'deepagents:langchain',
              },
            ],
            credentialProfileRef: 'gantry-model-access',
            modelRoute: {
              id: 'openrouter',
              label: 'OpenRouter',
              metadata: {
                providerModelId: 'moonshotai/kimi-k2.6',
              },
            },
            capabilities: expect.objectContaining({
              streaming: true,
              toolUse: true,
              cacheAccounting: true,
            }),
            supportedWorkloads: expect.arrayContaining([
              'chat',
              'memory_extractor',
            ]),
            // Cost is surfaced from the curated catalog pricing...
            inputUsdPerMillionTokens: expect.any(Number),
            outputUsdPerMillionTokens: expect.any(Number),
            // ...and credential-aware availability is present on the list
            // endpoint (false here: no OpenRouter credential configured).
            available: false,
          }),
        ]),
      );
    } finally {
      await handle.close();
    }
  });

  it('updates model defaults through settings-backed Control API routes', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    process.env.GANTRY_DATABASE_URL =
      'postgres://gantry:gantry@localhost:5432/gantry_test';
    process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
      } as any,
    });
    try {
      const patchResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/defaults`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: 'openrouter' }),
        },
      );
      expect(patchResponse.status).toBe(200);
      const patched = await patchResponse.json();
      expect(patched.chat.effectiveAlias).toBe('kimi');
      expect(patched.jobs.oneTime.effectiveAlias).toBe('kimi');
      expect(patched.memory.extractor.effectiveAlias).toBe('kimi');

      const settings = loadRuntimeSettings(runtimeHome);
      expect(settings.agent.defaultModel).toBe('kimi');
      expect(settings.agent.oneTimeJobDefaultModel).toBe('');
      expect(settings.memory.llm.models.extractor).toBe('kimi');

      const badResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/defaults`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memory: 'manual' }),
        },
      );
      expect(badResponse.status).toBe(400);
      expect(await badResponse.text()).toContain('memory must be null');

      const rawModelResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/defaults`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat: 'moonshotai/kimi-k2.6' }),
        },
      );
      expect(rawModelResponse.status).toBe(400);
      await expect(rawModelResponse.json()).resolves.toMatchObject({
        error: {
          message: expect.stringContaining(
            'Provider model ID "moonshotai/kimi-k2.6" is not accepted here',
          ),
        },
      });

      const legacyPresetResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/defaults`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerPreset: 'openrouter' }),
        },
      );
      expect(legacyPresetResponse.status).toBe(400);
      await expect(legacyPresetResponse.json()).resolves.toMatchObject({
        error: {
          message: 'Unsupported model defaults field "providerPreset".',
        },
      });
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      await handle.close();
    }
  });

  it('previews chat model selection with session overrides', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'reader-key',
        scopes: ['sessions:read'],
        appId: 'app-one',
      },
    ]);

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
        getConversationRoutes: () => ({
          'app:app-one:session-1': {
            jid: 'app:app-one:session-1',
            name: 'Session 1',
            folder: 'session-1',
            agentConfig: { model: 'sonnet' },
          },
        }),
      } as any,
    });
    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/preview`,
        'reader-key',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            target: 'chat',
            conversationJid: 'app:app-one:session-1',
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        scope: 'app:app-one:session-1',
        selection: {
          effectiveAlias: 'sonnet',
          source: 'conversation.agentConfig.model',
          inherited: false,
          model: {
            displayName: 'Sonnet 4.6',
          },
        },
        why: [expect.stringContaining('uses a session /model override')],
      });
    } finally {
      await handle.close();
    }
  });

  it('preflights OpenRouter defaults before writing settings through the Control API', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['sessions:read', 'agents:admin'],
        appId: 'app-one',
      },
    ]);
    mockedPreflightModelPreset.mockResolvedValueOnce({
      ok: false,
      status: 'fail',
      message: 'OpenRouter Model Access credential is missing.',
    });

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });
    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/defaults`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: 'openrouter' }),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          message: expect.stringContaining('Preset preflight failed'),
        },
      });
      expect(loadRuntimeSettings(runtimeHome).agent.defaultModel).not.toBe(
        'kimi',
      );
    } finally {
      await handle.close();
    }
  });

  it('preflights inherited OpenRouter defaults before writing reset patches', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'kimi';
    settings.agent.oneTimeJobDefaultModel = 'sonnet';
    settings.agent.recurringJobDefaultModel = 'sonnet';
    saveRuntimeSettings(runtimeHome, settings);
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['sessions:read', 'agents:admin'],
        appId: 'app-one',
      },
    ]);
    mockedPreflightModelPreset.mockResolvedValueOnce({
      ok: false,
      status: 'fail',
      message: 'OpenRouter Model Access credential is missing.',
    });

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });
    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/models/defaults`,
        'admin-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobs: 'inherit' }),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          message: expect.stringContaining('Preset preflight failed'),
        },
      });
      const after = loadRuntimeSettings(runtimeHome);
      expect(after.agent.oneTimeJobDefaultModel).toBe('sonnet');
      expect(after.agent.recurringJobDefaultModel).toBe('sonnet');
    } finally {
      await handle.close();
    }
  });

  it('rejects settings patches from non-admin keys before read-only handling', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'read-key',
        scopes: ['sessions:read'],
        appId: 'app-one',
      },
    ]);

    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
        getRuntimeSettings: vi.fn(),
      } as any,
    });
    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/settings`,
        'read-key',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            databaseUrl: 'postgres://secret',
          }),
        },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'FORBIDDEN',
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('keeps typed settings patches read-only before patch validation', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['agents:admin', 'conversations:admin'],
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
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'SETTINGS_READ_ONLY',
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('does not parse malformed typed runtime settings patches in read-only mode', async () => {
    const runtimeHome = '/tmp/gantry-control-test-home';
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'admin-key',
        scopes: ['agents:admin', 'conversations:admin'],
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
            permissions: {
              yoloMode: { enabled: false },
              egress: { denylist: [1] },
            },
          }),
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'SETTINGS_READ_ONLY',
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('rejects bearer auth when key is not app-bound', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'missing-app',
        token: 'bad-key',
        scopes: ['sessions:read'],
      },
    ]);

    expect(() =>
      startControlServer({
        app: {
          registerGroup: vi.fn(),
          queue: { enqueueMessageCheck: vi.fn() },
        } as any,
      }),
    ).toThrow('appId must be a valid control id');
  });

  it('sets unix socket mode to 0600', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-control-socket-'),
    );
    const socketPath = path.join(tempDir, 'control.sock');
    process.env.GANTRY_CONTROL_SOCKET_PATH = socketPath;
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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

  it('fails startup when control key config is malformed', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = '{"kid":"broken"';

    expect(() =>
      startControlServer({
        app: { queue: { enqueueMessageCheck: vi.fn() } } as any,
      }),
    ).toThrow('GANTRY_CONTROL_API_KEYS_JSON must be valid JSON');
  });

  it('blocks session ensure for mismatched app access', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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

  it('returns forbidden when an otherwise valid key lacks required scope', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-read-only',
        scopes: ['sessions:read'],
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
        'token-read-only',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            conversationId: 'conv-1',
          }),
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'FORBIDDEN',
        },
      });
      expect(app.registerGroup).not.toHaveBeenCalled();
      expect(controlRepo.ensureAppSession).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('uses API key app scope when session ensure omits appId', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_PORT = String(port);
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': signed.signature,
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

  it('accepts signed external ingress conversation messages with Gantry ids only in the response', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const app = {
      registerGroup: vi.fn(async () => undefined),
      getConversationRoutes: vi.fn(() => ({
        'tg:-100': {
          name: 'Team Topic',
          folder: 'main_agent',
          trigger: '',
          added_at: '2026-04-24T00:00:00.000Z',
          requiresTrigger: false,
          conversationKind: 'channel',
        },
      })),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    controlRepo.getExternalIngressById.mockResolvedValue({
      ingressId: 'ingress-1',
      appId: 'app-one',
      name: 'ingress-main',
      secret: 'ingress-secret',
      enabled: true,
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['conversation_message'],
          conversationIds: ['conversation:tg:-100'],
        },
      },
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
    });
    domainRepositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation:tg:-100',
      appId: 'app-one',
      providerConnectionId: 'channel-providerConnection:app-one:telegram',
      externalRef: { kind: 'conversation', value: '-100' },
      kind: 'group',
      title: 'Team Topic',
      status: 'active',
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
    });
    domainRepositories.conversations.getThread.mockResolvedValue({
      id: 'thread:tg:-100:42',
      appId: 'app-one',
      conversationId: 'conversation:tg:-100',
      externalRef: { kind: 'conversation_thread', value: '42' },
      title: 'Topic',
      status: 'active',
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
    });
    const handle = startControlServer({ app: app as any });
    const path = '/v1/ingresses/ingress-1/invoke';
    const rawBody = JSON.stringify({
      target: {
        kind: 'conversation_message',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        message: 'run the test',
        senderId: 'external-ci',
        senderName: 'External CI',
      },
      idempotencyKey: 'idem-ingress-conversation-message',
    });
    const signed = signIngressRequest({
      ingressId: 'ingress-1',
      path,
      rawBody,
      nonce: 'nonce-ingress-conversation-message',
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}${path}`,
        '',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': signed.signature,
          },
          body: rawBody,
        },
      );

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toMatchObject({
        duplicate: false,
        targetKind: 'conversation_message',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        messageId: expect.any(String),
        acceptedEventId: 1001,
      });
      expect(body).not.toHaveProperty('enqueue');
      expect(body).not.toHaveProperty('conversationJid');
      expect(JSON.stringify(body)).not.toContain('queueKey');
      expect(opsRepo.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: 'tg:-100',
          thread_id: '42',
          sender: 'external-ci',
          sender_name: 'External CI',
          content: 'run the test',
        }),
      );
      expect(runtimeEvents.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          conversationId: 'conversation:tg:-100',
          threadId: 'thread:tg:-100:42',
          eventType: 'conversation.message.inbound',
          actor: 'external-ci',
          payload: expect.objectContaining({
            direction: 'inbound',
            deliveryStatus: 'accepted',
          }),
        }),
      );
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'tg:-100::thread:42',
      );
      expect(app.registerGroup).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects missing external ingress signature headers before lookup', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
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
    process.env.GANTRY_CONTROL_PORT = String(port);
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': 'bad-signature',
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-token',
        scopes: ['memory:admin'],
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

  it('rejects direct HTTP memory writes with non-direct-save kinds', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-token',
        scopes: ['memory:admin'],
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
            appId: 'app-one',
            agentId: 'agent',
            groupId: 'group',
            kind: 'reference',
            key: 'reference:raw-log',
            value: 'Internal references are not direct-save payloads.',
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      expect(memoryService.save).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('passes admin authority only when memory:admin scope is present', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-admin-token',
        scopes: ['memory:admin'],
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-disabled-token',
        scopes: ['memory:admin'],
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

  it('rejects provider routes when the token lacks provider scopes', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
        `http://127.0.0.1:${port}/v1/providers`,
        'sessions-only-token',
      );
      expect(response.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it('rejects raw channel secrets in providerConnection config', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'providers-admin-token',
        scopes: ['providers:admin'],
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
        `http://127.0.0.1:${port}/v1/provider-connections`,
        'providers-admin-token',
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
        domainRepositories.providerConnections.saveProviderConnection,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects placeholder provider connection creation', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'providers-admin-token',
        scopes: ['providers:admin'],
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
        `http://127.0.0.1:${port}/v1/provider-connections`,
        'providers-admin-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: 'app-one',
            providerId: 'whatsapp',
            label: 'WhatsApp',
          }),
        },
      );
      expect(response.status).toBe(501);
      expect(
        domainRepositories.providerConnections.saveProviderConnection,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects discovery for disabled provider connections', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'providers-admin-token',
        scopes: ['providers:admin'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.providerConnections.getProviderConnection.mockResolvedValue(
      {
        id: 'providerConnection-1',
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
        `http://127.0.0.1:${port}/v1/provider-connections/providerConnection-1/discover-conversations`,
        'providers-admin-token',
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'provider-all-token',
        scopes: [
          'providers:read',
          'providers:admin',
          'conversations:read',
          'conversations:admin',
          'messages:read',
          'agents:admin',
        ],
        appId: 'app-one',
      },
    ]);
    const iso = new Date(0).toISOString();
    const providerConnection = {
      id: 'providerConnection-1',
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
      ...providerConnection,
      status: 'disabled',
      updatedAt: '2026-04-27T00:00:01.000Z',
    };
    const updatedInstallation = {
      ...providerConnection,
      label: 'App workspace',
      updatedAt: '2026-04-27T00:00:02.000Z',
    };
    const conversation = {
      id: 'conversation-1',
      appId: 'app-one',
      providerConnectionId: 'providerConnection-1',
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
      providerConnectionId: 'providerConnection-1',
      conversationId: 'conversation-1',
      displayName: 'engineering',
      status: 'disabled',
      triggerMode: 'mention',
      requiresTrigger: true,
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

    domainRepositories.providerConnections.listProviderConnections.mockResolvedValue(
      [providerConnection],
    );
    domainRepositories.providerConnections.getProviderConnection.mockResolvedValue(
      providerConnection,
    );
    domainRepositories.providerConnections.updateProviderConnection.mockResolvedValue(
      updatedInstallation,
    );
    domainRepositories.providerConnections.disableProviderConnection.mockResolvedValue(
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
    domainRepositories.providerConnections.listAgentConversationBindings.mockResolvedValue(
      [disabledBinding],
    );
    domainRepositories.providerConnections.getAgentConversationBinding.mockResolvedValue(
      disabledBinding,
    );
    domainRepositories.providerConnections.disableAgentConversationBinding.mockResolvedValue(
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
        'provider-all-token',
        init,
      );
      expect(response.status).toBe(expectedStatus);
      return await response.json();
    }

    try {
      expect(
        ProviderListResponseSchema.parse(
          await jsonFor('/v1/providers'),
        ).providers.map((provider) => provider.id),
      ).toEqual(expect.arrayContaining(['app', 'teams', 'whatsapp']));

      ProviderConnectionListResponseSchema.parse(
        await jsonFor('/v1/provider-connections'),
      );
      ProviderConnectionResponseSchema.parse(
        await jsonFor(
          '/v1/provider-connections',
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
      ProviderConnectionResponseSchema.parse(
        await jsonFor('/v1/provider-connections/providerConnection-1'),
      );
      ProviderConnectionResponseSchema.parse(
        await jsonFor('/v1/provider-connections/providerConnection-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'App workspace' }),
        }),
      );
      expect(
        ProviderConnectionResponseSchema.parse(
          (
            await jsonFor('/v1/provider-connections/providerConnection-1', {
              method: 'DELETE',
            })
          ).providerConnection,
        ).status,
      ).toBe('disabled');
      ConversationListResponseSchema.parse(
        await jsonFor(
          '/v1/provider-connections/providerConnection-1/discover-conversations',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ limit: 10 }),
          },
        ),
      );

      ConversationListResponseSchema.parse(
        await jsonFor(
          '/v1/conversations?providerConnectionId=providerConnection-1',
        ),
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

      AgentConversationBindingListResponseSchema.parse(
        await jsonFor('/v1/agents/agent-1/conversation-bindings'),
      );
      expect(
        AgentConversationBindingResponseSchema.parse(
          await jsonFor(
            '/v1/agents/agent-1/conversation-bindings/conversation-1',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                triggerMode: 'mention',
                memoryScope: 'conversation',
              }),
            },
          ),
        ).status,
      ).toBe('active');
      expect(
        AgentConversationBindingResponseSchema.parse(
          await jsonFor(
            '/v1/agents/agent-1/conversation-bindings/conversation-1',
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ displayName: 'Engineering Bot' }),
            },
          ),
        ).status,
      ).toBe('disabled');
      expect(
        AgentConversationBindingResponseSchema.parse(
          (
            await jsonFor(
              '/v1/agents/agent-1/conversation-bindings/conversation-1',
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

  it('shows agent capabilities and conversation-owned policies in agent admin API', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'agents-admin-token',
        scopes: ['agents:admin', 'conversations:admin'],
        appId: 'app-one',
      },
    ]);
    const iso = new Date(0).toISOString();
    domainRepositories.agents.getAgent.mockResolvedValue({
      id: 'agent-1',
      appId: 'app-one',
      name: 'Agent',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    });
    domainRepositories.providerConnections.listAgentConversationBindings.mockResolvedValue(
      [
        {
          id: 'binding-slack',
          appId: 'app-one',
          agentId: 'agent-1',
          conversationId: 'conversation:slack:C123',
          status: 'active',
          requiresTrigger: true,
        },
        {
          id: 'binding-teams',
          appId: 'app-one',
          agentId: 'agent-1',
          conversationId: 'conversation:teams:19:channel@thread.tacv2',
          status: 'active',
          requiresTrigger: false,
        },
        {
          id: 'binding-disabled',
          appId: 'app-one',
          agentId: 'agent-1',
          conversationId: 'conversation:slack:C999',
          status: 'disabled',
          requiresTrigger: true,
        },
      ],
    );
    domainRepositories.conversations.getConversation.mockImplementation(
      async (conversationId: string) => {
        if (conversationId === 'conversation:slack:C123') {
          return {
            id: conversationId,
            appId: 'app-one',
            providerConnectionId: 'providerConnection-slack',
            kind: 'channel',
            title: 'Sales Slack',
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          };
        }
        if (conversationId === 'conversation:teams:19:channel@thread.tacv2') {
          return {
            id: conversationId,
            appId: 'app-one',
            providerConnectionId: 'providerConnection-teams',
            kind: 'channel',
            title: 'Sales Teams',
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          };
        }
        return null;
      },
    );
    domainRepositories.providerConnections.getProviderConnection.mockImplementation(
      async (providerConnectionId: string) => {
        if (providerConnectionId === 'providerConnection-slack') {
          return {
            id: providerConnectionId,
            appId: 'app-one',
            providerId: 'slack',
            label: 'Slack',
            status: 'active',
            config: {},
            runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
            createdAt: iso,
            updatedAt: iso,
          };
        }
        if (providerConnectionId === 'providerConnection-teams') {
          return {
            id: providerConnectionId,
            appId: 'app-one',
            providerId: 'teams',
            label: 'Teams',
            status: 'active',
            config: {},
            runtimeSecretRefs: ['TEAMS_CLIENT_ID'],
            createdAt: iso,
            updatedAt: iso,
          };
        }
        return null;
      },
    );
    domainRepositories.conversations.listConversationApprovers.mockImplementation(
      async (conversationId: string) => {
        const userIds =
          conversationId === 'conversation:slack:C123'
            ? ['UADMIN']
            : conversationId === 'conversation:teams:19:channel@thread.tacv2'
              ? ['8:orgid:admin']
              : [];
        return userIds.map((externalUserId) => ({
          id: `approver:${conversationId}:${externalUserId}`,
          appId: 'app-one',
          conversationId,
          externalUserId,
          createdAt: iso,
          updatedAt: iso,
        }));
      },
    );
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const adminResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/admin`,
        'agents-admin-token',
      );
      expect(adminResponse.status).toBe(200);
      expect(await adminResponse.json()).toMatchObject({
        agent: { id: 'agent-1' },
        boundConversations: [
          {
            conversationId: 'conversation:slack:C123',
            provider: 'slack',
            kind: 'channel',
            displayName: 'Sales Slack',
            approverUserIds: ['UADMIN'],
            requiresTrigger: true,
          },
          {
            conversationId: 'conversation:teams:19:channel@thread.tacv2',
            provider: 'teams',
            kind: 'channel',
            displayName: 'Sales Teams',
            approverUserIds: ['8:orgid:admin'],
            requiresTrigger: false,
          },
        ],
      });
    } finally {
      await handle.close();
    }
  });

  it('manages conversation approvers without conversation-owned DM access', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'providers-admin-token',
        scopes: ['conversations:read', 'conversations:admin'],
        appId: 'app-one',
      },
    ]);
    const iso = new Date(0).toISOString();
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'app-one',
      providerId: 'app',
      label: 'App',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: iso,
      updatedAt: iso,
    };
    const conversation = {
      id: 'conversation-1',
      appId: 'app-one',
      providerConnectionId: 'providerConnection-1',
      externalRef: { kind: 'conversation', value: 'app-conv-1' },
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    domainRepositories.providerConnections.getProviderConnection.mockResolvedValue(
      providerConnection,
    );
    domainRepositories.conversations.getConversation.mockResolvedValue(
      conversation,
    );
    domainRepositories.conversations.listParticipantExternalUserIds.mockResolvedValue(
      ['user-2'],
    );
    domainRepositories.conversations.listConversationApprovers.mockResolvedValueOnce(
      [
        {
          id: 'approver-1',
          appId: 'app-one',
          conversationId: 'conversation-1',
          externalUserId: 'user-1',
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    );
    domainRepositories.conversations.replaceConversationApprovers.mockResolvedValue(
      [
        {
          id: 'approver-2',
          appId: 'app-one',
          conversationId: 'conversation-1',
          externalUserId: 'user-2',
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    );
    const handle = startControlServer({
      app: {
        registerGroup: vi.fn(),
        queue: { enqueueMessageCheck: vi.fn() },
      } as any,
    });

    try {
      const adminResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/conversations/conversation-1/approvers`,
        'providers-admin-token',
      );
      expect(adminResponse.status).toBe(200);
      expect(await adminResponse.json()).toMatchObject({
        approvers: { userIds: ['user-1'] },
      });

      const updateResponse = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/conversations/conversation-1/approvers`,
        'providers-admin-token',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userIds: ['user-2', 'user-2'] }),
        },
      );
      expect(updateResponse.status).toBe(200);
      expect(await updateResponse.json()).toEqual({
        approvers: { userIds: ['user-2'] },
      });
      expect(
        domainRepositories.conversations.replaceConversationApprovers,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ externalUserIds: ['user-2'] }),
      );
      expect(
        domainRepositories.providerConnections.updateProviderConnection,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it.each([
    {
      name: 'providers:admin',
      path: '/v1/provider-connections',
      tokenScopes: ['providers:read'],
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
      tokenScopes: ['providers:read'],
    },
    {
      name: 'messages:read',
      path: '/v1/conversations/conversation-1/messages',
      tokenScopes: ['conversations:read'],
    },
    {
      name: 'conversations:read for binding list',
      path: '/v1/agents/agent-1/conversation-bindings',
      tokenScopes: ['agents:admin'],
    },
    {
      name: 'agents:admin',
      path: '/v1/agents/agent-1/conversation-bindings/conversation-1',
      tokenScopes: ['providers:read'],
      init: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ triggerMode: 'mention' }),
      },
    },
    {
      name: 'conversations:admin for conversation approvers',
      path: '/v1/conversations/conversation-1/approvers',
      tokenScopes: ['conversations:read'],
      init: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: ['user-1'] }),
      },
    },
  ])(
    'rejects route group without $name scope',
    async ({ path, tokenScopes, init }) => {
      const port = await reservePort();
      process.env.GANTRY_CONTROL_PORT = String(port);
      process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
        expect(response.status).toBe(403);
      } finally {
        await handle.close();
      }
    },
  );

  it('lists conversation messages with messages:read scope', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
      providerConnectionId: 'providerConnection-1',
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

  it('enables and disables an agent conversation binding through repository state', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'agents-admin-token',
        scopes: ['agents:admin', 'conversations:admin'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation-1',
      appId: 'app-one',
      providerConnectionId: 'providerConnection-1',
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    domainRepositories.providerConnections.getProviderConnection.mockResolvedValue(
      {
        id: 'providerConnection-1',
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
    domainRepositories.providerConnections.disableAgentConversationBinding.mockResolvedValue(
      {
        id: 'binding-1',
        appId: 'app-one',
        agentId: 'agent-1',
        providerConnectionId: 'providerConnection-1',
        conversationId: 'conversation-1',
        displayName: 'engineering',
        status: 'disabled',
        triggerMode: 'mention',
        requiresTrigger: true,
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
        `http://127.0.0.1:${port}/v1/agents/agent-1/conversation-bindings/conversation-1`,
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
        domainRepositories.providerConnections.saveAgentConversationBinding,
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
        `http://127.0.0.1:${port}/v1/agents/agent-1/conversation-bindings/conversation-1`,
        'agents-admin-token',
        { method: 'DELETE' },
      );
      expect(disableResponse.status).toBe(200);
      expect(
        domainRepositories.providerConnections.disableAgentConversationBinding,
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

  it('rejects invalid or missing agent conversation binding updates', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'agents-admin-token',
        scopes: ['agents:admin', 'conversations:admin'],
        appId: 'app-one',
      },
    ]);
    domainRepositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation-1',
      appId: 'app-one',
      providerConnectionId: 'providerConnection-1',
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    domainRepositories.providerConnections.getProviderConnection.mockResolvedValue(
      {
        id: 'providerConnection-1',
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
        `http://127.0.0.1:${port}/v1/agents/agent-1/conversation-bindings/conversation-1`,
        'agents-admin-token',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: 'Engineering Bot' }),
        },
      );
      expect(missingPatch.status).toBe(404);

      const missingDelete = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/conversation-bindings/conversation-1`,
        'agents-admin-token',
        { method: 'DELETE' },
      );
      expect(missingDelete.status).toBe(404);

      const missingUserSubject = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent-1/conversation-bindings/conversation-1`,
        'agents-admin-token',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memoryScope: 'user' }),
        },
      );
      expect(missingUserSubject.status).toBe(400);
      expect(
        domainRepositories.providerConnections.saveAgentConversationBinding,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('routes memory list, search, patch, delete, dreaming trigger, and status with app auth', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-all-token',
        scopes: ['memory:read', 'memory:admin'],
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'memory-disabled-all-token',
        scopes: ['memory:admin'],
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

  it('rejects unsafe session identifiers before registering app workspaces', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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

  it('rejects unsupported session ensure fields before registration', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-strict-session',
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
        'token-strict-session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: 'conv-1',
            modelOverride: 'sonnet',
          }),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Unsupported session request field "modelOverride".',
        },
      });
      expect(app.registerGroup).not.toHaveBeenCalled();
      expect(controlRepo.ensureAppSession).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('binds webhook registration to authenticated app id', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
      workspaceKey: 'app_app_one_conv_1',
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
      workspaceKey: 'app_app_one_conv_1',
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

  it('returns session event envelopes with correlation metadata from list events', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-events-list',
        scopes: ['sessions:read'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      workspaceKey: 'app_app_one_conv_1',
      title: 'Conversation',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    runtimeEvents.list.mockResolvedValue([
      {
        eventId: 21,
        appId: 'app-one',
        sessionId: 'session-1',
        threadId: 'thread-1',
        correlationId: 'corr-1',
        eventType: 'session.message.outbound',
        payload: { text: 'hello' },
        createdAt: '2026-05-08T00:00:02.000Z',
      },
    ]);
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/session-1/events?afterEventId=20`,
        'token-events-list',
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        events: [
          {
            eventId: 21,
            eventType: 'session.message.outbound',
            sessionId: 'session-1',
            threadId: 'thread-1',
            correlationId: 'corr-1',
            createdAt: '2026-05-08T00:00:02.000Z',
            payload: { text: 'hello' },
          },
        ],
      });
    } finally {
      await handle.close();
    }
  });

  it('streams session event envelopes over SSE with metadata and payload', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-events-sse',
        scopes: ['sessions:read'],
        appId: 'app-one',
      },
    ]);
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      workspaceKey: 'app_app_one_conv_1',
      title: 'Conversation',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    runtimeEvents.list.mockResolvedValue([
      {
        eventId: 22,
        appId: 'app-one',
        sessionId: 'session-1',
        threadId: 'thread-1',
        correlationId: 'corr-sse',
        eventType: 'session.message.outbound',
        payload: { text: 'hello from stream' },
        createdAt: '2026-05-08T00:00:03.000Z',
      },
    ]);
    runtimeEvents.subscribe.mockReturnValue({
      next: vi.fn(
        async () =>
          await new Promise<never[]>((resolve) =>
            setTimeout(() => resolve([]), 50),
          ),
      ),
      close: vi.fn(),
    });
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const controller = new AbortController();
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/sessions/session-1/events`,
        'token-events-sse',
        {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      const first = await reader?.read();
      const chunk = Buffer.from(first?.value ?? new Uint8Array()).toString(
        'utf8',
      );
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse((dataLine ?? '').slice(6));
      expect(payload).toMatchObject({
        eventId: 22,
        eventType: 'session.message.outbound',
        sessionId: 'session-1',
        threadId: 'thread-1',
        correlationId: 'corr-sse',
        createdAt: '2026-05-08T00:00:03.000Z',
        payload: { text: 'hello from stream' },
      });
      controller.abort();
    } finally {
      await handle.close();
    }
  });

  it('waits over the full session cursor while returning only visible events', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
      workspaceKey: 'app_app_one_conv_1',
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
          threadId: 'thread-1',
          correlationId: 'corr-wait',
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
        sessionId: 'session-1',
        threadId: 'thread-1',
        correlationId: 'corr-wait',
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
    process.env.GANTRY_CONTROL_PORT = String(port);
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
    process.env.GANTRY_CONTROL_PORT = String(port);
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': signed.signature,
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
    process.env.GANTRY_CONTROL_PORT = String(port);
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
            'x-gantry-ingress-timestamp': stale.timestamp,
            'x-gantry-ingress-nonce': stale.nonce,
            'x-gantry-ingress-signature': stale.signature,
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
            'x-gantry-ingress-timestamp': String(Date.now()),
            'x-gantry-ingress-nonce': 'nonce-bad-sig',
            'x-gantry-ingress-signature': 'bad-signature',
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
    process.env.GANTRY_CONTROL_PORT = String(port);
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': signed.signature,
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': 'nonce-duplicate-active',
            'x-gantry-ingress-signature': signIngressRequest({
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    const app = {
      registerGroup: vi.fn(),
      queue: { enqueueMessageCheck: vi.fn() },
    };
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      workspaceKey: 'app_app_one_conv_1',
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': signed.signature,
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
            'x-gantry-ingress-timestamp': signed.timestamp,
            'x-gantry-ingress-nonce': signed.nonce,
            'x-gantry-ingress-signature': signed.signature,
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    controlRepo.getAppSessionById.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
      workspaceKey: 'app_app_one_conv_1',
      title: null,
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    opsRepo.getJobById.mockResolvedValue({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run this',
      model: null,
      schedule_type: 'manual',
      schedule_value: 'manual',
      status: 'active',
      session_id: 'session-1',
      thread_id: null,
      workspace_key: 'app_app_one_conv_1',
      created_by: 'human',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      next_run: null,
      last_run: null,
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

  it('lists app runs only after resolving visible canonical jobs', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k',
        token: 'token-runs-list',
        scopes: ['jobs:read'],
        appId: 'app-one',
      },
    ]);
    const job = {
      id: 'job-1',
      name: 'Job',
      prompt: 'Run this',
      model: null,
      schedule_type: 'manual',
      schedule_value: 'manual',
      status: 'active',
      session_id: 'session-1',
      thread_id: null,
      workspace_key: 'app_app_one_conv_1',
      created_by: 'human',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      next_run: null,
      last_run: null,
      lease_run_id: null,
      lease_expires_at: null,
      consecutive_failures: 0,
      max_retries: 3,
      retry_backoff_ms: 1000,
    };
    opsRepo.listJobs.mockResolvedValue([job]);
    controlRepo.getAppSessionsByIds.mockResolvedValue([
      {
        sessionId: 'session-1',
        appId: 'app-one',
        conversationId: 'conv-1',
        chatJid: 'app:app-one:conv-1',
        workspaceKey: 'app_app_one_conv_1',
        title: null,
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
    opsRepo.listJobRuns.mockResolvedValue([
      {
        run_id: 'run-1',
        job_id: 'job-1',
        scheduled_for: '2026-04-24T00:00:00.000Z',
        started_at: '2026-04-24T00:00:00.000Z',
        ended_at: null,
        status: 'running',
        result_summary: null,
        error_summary: null,
        retry_count: 0,
        notified_at: null,
        provider_run_id: 'provider-run-secret',
        provider_session_id: 'provider-session-secret',
      },
    ]);
    const handle = startControlServer({
      app: { registerGroup: vi.fn(), queue: { enqueueMessageCheck: vi.fn() } },
    } as any);

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/runs`,
        'token-runs-list',
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        runs: [{ run_id: 'run-1', job_id: 'job-1' }],
      });
      expect(body.runs[0]).not.toHaveProperty('provider_run_id');
      expect(body.runs[0]).not.toHaveProperty('provider_session_id');
      expect(opsRepo.listJobs).not.toHaveBeenCalled();
      expect(opsRepo.listJobRuns).toHaveBeenCalledWith(undefined, 100, {
        ownerAppId: 'app-one',
      });
    } finally {
      await handle.close();
    }
  });

  it('scopes webhook lookups to the authenticated app id', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_PORT = String(port);
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
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
    process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
    const received: Array<{ body: string; signature: string | undefined }> = [];
    const receiver = net.createServer((socket) => {
      let raw = '';
      socket.on('data', (chunk) => {
        raw += chunk.toString();
        if (!raw.includes('\r\n\r\n')) return;
        const body = raw.split('\r\n\r\n')[1] ?? '';
        const signature = /x-gantry-webhook-signature: ([^\r\n]+)/i.exec(
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
      delete process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS;
      delete process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
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

    process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
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
      delete process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS;
      delete process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
    }
  });
});

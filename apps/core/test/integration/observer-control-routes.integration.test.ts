import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createResolveObserverStatus } from '@core/application/control-plane/control-plane-storage-model.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleObserverRoutes } from '@core/control/server/routes/observer.js';
import type { ProactiveInsight } from '@core/domain/ports/observer-insights.js';

const observerRepository = vi.hoisted(() => ({
  count: vi.fn(),
  list: vi.fn(),
}));
const brainStatus = vi.hoisted(() => vi.fn());
const conversationRepository = vi.hoisted(() => ({
  getConversationByExternalRef: vi.fn(),
  listParticipantExternalUserIds: vi.fn(),
  listConversationApprovers: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      observerInsights: observerRepository,
      conversations: conversationRepository,
    },
  }),
}));

vi.mock('@core/brain/brain-runtime.js', () => ({
  createRuntimeBrainService: () => ({ status: brainStatus }),
}));

type TestResponse = ServerResponse & { body: string };

function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    setHeader() {
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as TestResponse;
}

function request(): IncomingMessage {
  return {
    method: 'GET',
    headers: { authorization: 'Bearer observer-test-token' },
  } as IncomingMessage;
}

function context(
  settings: ReturnType<typeof createDefaultRuntimeSettings>,
  effectiveSettings = settings,
  effectiveMemoryState = {
    enabled: effectiveSettings.memory.enabled,
    dreamingEnabled: effectiveSettings.memory.dreaming.enabled,
  },
): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'observer-test',
        tokenHash: createHash('sha256').update('observer-test-token').digest(),
        scopes: new Set(['memory:read']),
        appId: 'default',
      },
    ],
    getInternalRuntimeSettings: () => settings,
    getEffectiveRuntimeSettings: () => effectiveSettings,
    getEffectiveMemoryState: () => effectiveMemoryState,
    resolveObserverStatus: createResolveObserverStatus({
      getInternalRuntimeSettings: () => settings,
      getEffectiveRuntimeSettings: () => effectiveSettings,
      getEffectiveMemoryState: () => effectiveMemoryState,
      conversations: conversationRepository,
    }),
  } as ControlRouteContext;
}

function configuredSettings() {
  const settings = createDefaultRuntimeSettings();
  settings.providers.telegram = { enabled: true };
  settings.memory.embeddings.enabled = true;
  settings.memory.embeddings.provider = 'openai';
  settings.observer = {
    enabled: true,
    owner: { recipient: 'owner-1', conversation: 'owner_dm' },
  };
  settings.providerAccounts.telegram_default = {
    agentId: 'main_agent',
    provider: 'telegram',
    label: 'Telegram',
    runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
  };
  settings.conversations.owner_dm = {
    providerAccount: 'telegram_default',
    externalId: 'owner-1',
    kind: 'dm',
    displayName: 'Owner DM',
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: ['owner-1'],
  };
  return settings;
}

const SUBJECT = 'msu_33333333333333333333333333333333' as const;

const insight: ProactiveInsight = {
  id: 'insight-1',
  appId: 'default',
  subject: SUBJECT,
  insightType: 'commitment',
  title: 'Follow up',
  summary: 'A promised follow-up is still open.',
  evidenceRefs: [
    {
      conversationId: 'conversation:tg:observed-channel',
      messageId: 'message-1',
      ts: '2026-07-21T00:00:00.000Z',
    },
  ],
  batchSnapshotAt: '2026-07-21T00:00:00.000Z',
  evidenceVersion: 1,
  canonicalSignature: 'commitment:follow-up',
  signatureEmbeddingRef: null,
  confidence: 0.9,
  priorityScore: 0.8,
  state: 'pending',
  cooldownUntil: null,
  resolvedAt: null,
  surfacedAt: null,
  recipient: 'owner-1',
  deliveryId: null,
  createdAt: '2026-07-21T01:00:00.000Z',
  updatedAt: '2026-07-21T01:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  conversationRepository.getConversationByExternalRef.mockResolvedValue({
    id: 'conversation:telegram_default:tg:owner-1',
    kind: 'direct',
  });
  conversationRepository.listParticipantExternalUserIds.mockResolvedValue([
    'owner-1',
  ]);
  conversationRepository.listConversationApprovers.mockResolvedValue([
    { externalUserId: 'owner-1' },
  ]);
});

describe('observer control routes', () => {
  it('reports the honest evidence-accumulating status and durable counts', async () => {
    const settings = configuredSettings();
    settings.memory.dreaming.enabled = false;
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockImplementation(
      async ({ state }: { state?: string }) => (state === 'pending' ? 2 : 3),
    );
    const res = responseRecorder();

    await expect(
      handleObserverRoutes(
        request(),
        res,
        context(settings),
        new URL('http://localhost/v1/observer/status'),
        '/v1/observer/status',
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      activation: 'evidence_accumulating',
      dreamingEnabled: false,
      message:
        'Dreaming is off; evidence is accumulating, but promotion is disabled.',
      owner: {
        recipient: 'owner-1',
        conversation: 'owner_dm',
        conversationJid: 'tg:owner-1',
        providerAccountId: 'telegram_default',
      },
      counts: { evidence: 7, insights: 3, pendingInsights: 2 },
    });
  });

  it('resolves a Teams owner with a colon-bearing external conversation ID', async () => {
    const settings = configuredSettings();
    settings.providers.teams = { enabled: true };
    settings.providerAccounts.teams_default = {
      agentId: 'main_agent',
      provider: 'teams',
      label: 'Teams',
      runtimeSecretRefs: { client_id: 'TEAMS_CLIENT_ID' },
    };
    settings.conversations.owner_dm = {
      providerAccount: 'teams_default',
      externalId: 'teams:19:owner-thread@thread.v2',
      kind: 'dm',
      displayName: 'Owner DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['owner-1'],
    };
    settings.memory.dreaming.enabled = true;
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockResolvedValue(0);
    conversationRepository.getConversationByExternalRef.mockResolvedValue({
      id: 'conversation:teams_default:teams:19:owner-thread@thread.v2',
      kind: 'direct',
    });
    const res = responseRecorder();

    await handleObserverRoutes(
      request(),
      res,
      context(settings),
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    );

    expect(
      conversationRepository.getConversationByExternalRef,
    ).toHaveBeenCalledWith({
      appId: 'default',
      providerId: 'teams',
      providerAccountId: 'teams_default',
      externalConversationId: 'teams:19:owner-thread@thread.v2',
    });
    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      activation: 'active',
      owner: {
        conversationJid: 'teams:19:owner-thread@thread.v2',
        providerAccountId: 'teams_default',
      },
    });
  });

  it('reports the scheduler-owned dreaming gate instead of desired settings', async () => {
    const settings = configuredSettings();
    settings.memory.enabled = true;
    settings.memory.dreaming.enabled = true;
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockResolvedValue(0);
    const res = responseRecorder();

    await handleObserverRoutes(
      request(),
      res,
      context(settings, settings, { enabled: true, dreamingEnabled: false }),
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    );

    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      activation: 'evidence_accumulating',
      dreamingEnabled: false,
      message:
        'Dreaming is off; evidence is accumulating, but promotion is disabled.',
    });
  });
  it('requires the owner to exist in the verified conversation projection', async () => {
    const settings = configuredSettings();
    settings.memory.dreaming.enabled = true;
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockResolvedValue(0);
    conversationRepository.listParticipantExternalUserIds.mockResolvedValue([]);
    const res = responseRecorder();

    await handleObserverRoutes(
      request(),
      res,
      context(settings),
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    );

    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      activation: 'configuration_required',
      owner: null,
      message:
        'Observer owner must be a verified member and persisted control approver of the owner DM.',
    });
  });
  it('reports effective startup settings while restart-required changes are pending', async () => {
    const desired = configuredSettings();
    desired.memory.dreaming.enabled = true;
    const effective = createDefaultRuntimeSettings();
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockResolvedValue(0);
    const res = responseRecorder();

    await handleObserverRoutes(
      request(),
      res,
      context(desired, effective),
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    );

    expect(JSON.parse(res.body)).toMatchObject({
      enabled: false,
      activation: 'disabled',
      dreamingEnabled: false,
    });
  });

  it('resolves the effective owner against live-applied conversation settings', async () => {
    const effective = configuredSettings();
    effective.memory.dreaming.enabled = true;
    const current = configuredSettings();
    current.conversations.owner_dm!.externalId = 'owner-2';
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockResolvedValue(0);
    conversationRepository.getConversationByExternalRef.mockResolvedValue(null);
    const res = responseRecorder();

    await handleObserverRoutes(
      request(),
      res,
      context(current, effective),
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    );

    expect(
      conversationRepository.getConversationByExternalRef,
    ).toHaveBeenCalledWith({
      appId: 'default',
      providerId: 'telegram',
      providerAccountId: 'telegram_default',
      externalConversationId: 'owner-2',
    });
    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      activation: 'configuration_required',
      owner: null,
    });
  });

  it('keeps restart-owned provider topology at its effective startup state', async () => {
    const effective = configuredSettings();
    effective.memory.dreaming.enabled = true;
    const current = configuredSettings();
    current.providers.telegram!.enabled = false;
    current.providerAccounts.telegram_default!.status = 'disabled';
    brainStatus.mockResolvedValue({ channelPages: 7 });
    observerRepository.count.mockResolvedValue(0);
    const res = responseRecorder();

    await handleObserverRoutes(
      request(),
      res,
      context(current, effective),
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    );

    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      activation: 'active',
      owner: { providerAccountId: 'telegram_default' },
    });
  });

  it('lists scoped insights with a stable keyset cursor', async () => {
    const second = {
      ...insight,
      id: 'insight-2',
      createdAt: '2026-07-21T00:59:00.000Z',
    };
    observerRepository.list.mockResolvedValue([
      insight,
      second,
      {
        ...insight,
        id: 'insight-3',
        createdAt: '2026-07-21T00:58:00.000Z',
      },
    ]);
    const res = responseRecorder();
    const url = new URL(
      `http://localhost/v1/observer/insights?subject=${SUBJECT}&type=commitment&state=pending&limit=2`,
    );

    await expect(
      handleObserverRoutes(
        request(),
        res,
        context(configuredSettings()),
        url,
        url.pathname,
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(observerRepository.list).toHaveBeenCalledWith({
      appId: 'default',
      subject: SUBJECT,
      insightType: 'commitment',
      state: 'pending',
      limit: 3,
      before: undefined,
    });
    expect(observerRepository.count).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      insights: [insight, second],
      nextCursor: Buffer.from(
        JSON.stringify({ createdAt: second.createdAt, id: second.id }),
      ).toString('base64url'),
    });
  });

  it('rejects an invalid insight type filter', async () => {
    const res = responseRecorder();
    const url = new URL(
      'http://localhost/v1/observer/insights?type=not-an-insight',
    );

    await expect(
      handleObserverRoutes(
        request(),
        res,
        context(configuredSettings()),
        url,
        url.pathname,
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { code: 'INVALID_REQUEST', message: 'type is invalid' },
    });
    expect(observerRepository.list).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical subject filter', async () => {
    const res = responseRecorder();
    const url = new URL(
      'http://localhost/v1/observer/insights?subject=owner-1',
    );

    await expect(
      handleObserverRoutes(
        request(),
        res,
        context(configuredSettings()),
        url,
        url.pathname,
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { code: 'INVALID_REQUEST', message: 'subject is invalid' },
    });
    expect(observerRepository.list).not.toHaveBeenCalled();
  });
});

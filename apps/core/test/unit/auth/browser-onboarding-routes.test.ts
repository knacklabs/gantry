import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, expect, it, vi } from 'vitest';

const activeSession = vi.hoisted(() => vi.fn());
const requireBrowserMutationSession = vi.hoisted(() => vi.fn());
const onboardingCompletedAt = vi.hoisted(() => vi.fn());
const markOnboardingCompleted = vi.hoisted(() => vi.fn());
const onboardingStatus = vi.hoisted(() => vi.fn());
const operationReplay = vi.hoisted(() => vi.fn());
const saveOperation = vi.hoisted(() => vi.fn());
const stageModelCredentialCandidate = vi.hoisted(() => vi.fn());
const getModelCredentialCandidate = vi.hoisted(() => vi.fn());
const transitionModelCredentialCandidate = vi.hoisted(() => vi.fn());
const bindModelSelectionForVerification = vi.hoisted(() => vi.fn());
const activateModelAndCreateEmployee = vi.hoisted(() => vi.fn());
const recordProjectionReceipt = vi.hoisted(() => vi.fn());
const bindWorkAssignment = vi.hoisted(() => vi.fn());
const recordSlackWorkAssignment = vi.hoisted(() => vi.fn());
const getSlackWorkspaceCandidate = vi.hoisted(() => vi.fn());
const recordSlackWorkspaceActivation = vi.hoisted(() => vi.fn());
const verifyOnboardingModelCredential = vi.hoisted(() => vi.fn());
const isModelCredentialRejectedError = vi.hoisted(() => vi.fn());
const sendBrowserJoinConversation = vi.hoisted(() => vi.fn());
const listConversationMembers = vi.hoisted(() => vi.fn());
const validateControlAllowlist = vi.hoisted(() => vi.fn());
const latestSettingsRevision = vi.hoisted(() => vi.fn());
const createProviderAccount = vi.hoisted(() => vi.fn());
const updateProviderAccount = vi.hoisted(() => vi.fn());
const setCapabilitySecret = vi.hoisted(() => vi.fn());

vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  activeSession,
  requireBrowserMutationSession,
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    service: { db: {} },
    repositories: {
      settingsRevisions: { getLatestSettingsRevision: latestSettingsRevision },
      providerAccounts: { listProviderAccounts: vi.fn(async () => []) },
      capabilitySecrets: {},
    },
    runtimeEvents: { publish: vi.fn() },
  }),
}));
vi.mock(
  '@core/application/provider-conversations/provider-conversation-control-use-cases.js',
  () => ({
    ProviderAccountControlService: class {
      create = createProviderAccount;
      update = updateProviderAccount;
    },
    DiscoverProviderConversationsService: class {},
  }),
);
vi.mock(
  '@core/application/capability-secrets/capability-secret-service.js',
  () => ({
    CapabilitySecretService: class {
      set = setCapabilitySecret;
    },
  }),
);
vi.mock(
  '@core/application/onboarding/model-credential-verification.js',
  () => ({
    isModelCredentialRejectedError,
    verifyOnboardingModelCredential,
  }),
);
vi.mock('@core/control/server/routes/browser-conversation-members.js', () => ({
  createBrowserConversationAdministrationService: vi.fn(() => ({
    listConversationMembers,
    validateControlAllowlist,
  })),
  sendBrowserConversationMembers: vi.fn(),
  sendBrowserJoinConversation,
}));
vi.mock(
  '@core/adapters/storage/postgres/repositories/onboarding-lifecycle-repository.postgres.js',
  () => ({
    PostgresOnboardingLifecycleRepository: class {
      status = onboardingStatus;
      operationReplay = operationReplay;
      saveOperation = saveOperation;
      stageModelCredentialCandidate = stageModelCredentialCandidate;
      getModelCredentialCandidate = getModelCredentialCandidate;
      transitionModelCredentialCandidate = transitionModelCredentialCandidate;
      bindModelSelectionForVerification = bindModelSelectionForVerification;
      activateModelAndCreateEmployee = activateModelAndCreateEmployee;
      recordProjectionReceipt = recordProjectionReceipt;
      bindWorkAssignment = bindWorkAssignment;
      recordSlackWorkAssignment = recordSlackWorkAssignment;
      getSlackWorkspaceCandidate = getSlackWorkspaceCandidate;
      recordSlackWorkspaceActivation = recordSlackWorkspaceActivation;
    },
  }),
);
vi.mock(
  '@core/adapters/storage/postgres/repositories/authentication-repository.postgres.js',
  () => ({
    PostgresAuthenticationRepository: class {
      onboardingCompletedAt = onboardingCompletedAt;
      markOnboardingCompleted = markOnboardingCompleted;
    },
  }),
);

import {
  handleBrowserOnboardingRoutes,
  isBrowserOnboardingPath,
} from '@core/control/server/routes/browser-onboarding-lifecycle.js';

const settings = {
  authentication: {
    mode: 'local' as const,
    canonicalOrigin: 'http://127.0.0.1:3939',
  },
};
const session = { appId: 'default', userId: 'local-console:default' };
const syncSettingsFromProjection = vi.fn();
const connectProjectedChannels = vi.fn();
const ctx = { syncSettingsFromProjection, connectProjectedChannels } as never;

function request(method: string, body?: unknown): IncomingMessage {
  const req = Readable.from(
    body ? [JSON.stringify(body)] : [],
  ) as IncomingMessage;
  req.method = method;
  req.headers = body
    ? { 'content-type': 'application/json', 'idempotency-key': 'test-key' }
    : {};
  return req;
}

function response() {
  return {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
    },
  } as unknown as ServerResponse & { body: string };
}

beforeEach(() => {
  vi.resetAllMocks();
  operationReplay.mockResolvedValue(null);
  onboardingStatus.mockResolvedValue({ completed: false, deployment: null });
  stageModelCredentialCandidate.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    providerId: 'anthropic',
    authMode: 'api_key',
    state: 'staged',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  transitionModelCredentialCandidate.mockResolvedValue({});
  bindModelSelectionForVerification.mockResolvedValue({});
  activateModelAndCreateEmployee.mockResolvedValue({
    agentId: 'agent:atlas',
    name: 'Atlas',
    version: 1,
    desiredStateRevision: 2,
    replayed: false,
  });
  recordProjectionReceipt.mockResolvedValue(undefined);
  bindWorkAssignment.mockResolvedValue({
    approverPersonId: 'person:approver',
  });
  recordSlackWorkAssignment.mockResolvedValue({ version: 2 });
  listConversationMembers.mockResolvedValue([
    { id: 'U123', displayName: 'Ada Lovelace' },
  ]);
  validateControlAllowlist.mockResolvedValue({
    validUserIds: ['U123'],
    invalidUserIds: [],
  });
  latestSettingsRevision.mockResolvedValue({ revision: 7 });
  getSlackWorkspaceCandidate.mockResolvedValue({
    id: 'provider-candidate-1',
    agentId: 'agent:atlas',
    state: 'verified',
    credentials: { bot_token: 'bot-secret', app_token: 'app-secret' },
    externalIdentityJson: {
      appId: 'A123',
      teamId: 'T123',
      teamName: 'Workspace',
    },
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  createProviderAccount.mockResolvedValue({ id: 'slack-account' });
  updateProviderAccount.mockResolvedValue({
    id: 'slack-account',
    providerId: 'slack',
    label: 'Workspace',
    status: 'active',
  });
  isModelCredentialRejectedError.mockReturnValue(false);
  verifyOnboardingModelCredential.mockResolvedValue({ routeId: 'anthropic' });
});

it('reads completion for the authenticated user only', async () => {
  activeSession.mockResolvedValue(session);
  onboardingCompletedAt.mockResolvedValue(null);
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('GET'),
    res,
    ctx,
    '/ui/api/onboarding/status',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ completed: false, deployment: null });
  expect(onboardingCompletedAt).toHaveBeenCalledWith(session);
});

it('requires the standard mutation session before completing onboarding', async () => {
  requireBrowserMutationSession.mockResolvedValue(null);
  const denied = response();

  await handleBrowserOnboardingRoutes(
    request('POST'),
    denied,
    ctx,
    '/ui/api/onboarding/complete',
    settings,
  );
  expect(markOnboardingCompleted).not.toHaveBeenCalled();

  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  onboardingStatus.mockResolvedValue({
    completed: false,
    deployment: {
      state: 'ready',
      readyAt: '2026-09-18T00:00:00.000Z',
      version: 2,
    },
  });
  const accepted = response();
  await handleBrowserOnboardingRoutes(
    request('POST', { expectedVersion: 2 }),
    accepted,
    ctx,
    '/ui/api/onboarding/complete',
    settings,
  );

  expect(accepted.statusCode).toBe(200);
  expect(JSON.parse(accepted.body)).toEqual({ completed: true });
  expect(markOnboardingCompleted).toHaveBeenCalledWith(
    expect.objectContaining({ ...session, now: expect.any(String) }),
  );
});

it('limits the browser route to its two explicit paths', () => {
  expect(isBrowserOnboardingPath('/ui/api/onboarding/status')).toBe(true);
  expect(isBrowserOnboardingPath('/ui/api/onboarding/channel-manifest')).toBe(
    true,
  );
  expect(isBrowserOnboardingPath('/ui/api/onboarding/complete')).toBe(true);
  expect(isBrowserOnboardingPath('/ui/api/onboarding')).toBe(false);
});

it('returns the administrator-only Slack app manifest without credentials', async () => {
  activeSession.mockResolvedValue({ ...session, role: 'administrator' });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('GET'),
    res,
    ctx,
    '/ui/api/onboarding/channel-manifest',
    settings,
    new URL(
      'http://127.0.0.1:3939/ui/api/onboarding/channel-manifest?providerId=slack&employeeName=Ada%20Lovelace',
    ),
  );

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.manifestJson).toContain('Ada Lovelace');
  expect(body.manifestJson).toContain('/gantry');
  expect(body.createUrl).toContain('api.slack.com');
  expect(body.permissionGroups[0].scopes).toContain('commands');
});

it('rejects a viewer from reading the Slack app manifest', async () => {
  activeSession.mockResolvedValue({ ...session, role: 'viewer' });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('GET'),
    res,
    ctx,
    '/ui/api/onboarding/channel-manifest',
    settings,
    new URL(
      'http://127.0.0.1:3939/ui/api/onboarding/channel-manifest?providerId=slack',
    ),
  );

  expect(res.statusCode).toBe(403);
});

it('joins a discovered Slack channel through the protected mutation route', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', {}),
    res,
    ctx,
    '/ui/api/onboarding/conversations/conversation%3Aslack%3AC123/join',
    settings,
  );

  expect(sendBrowserJoinConversation).toHaveBeenCalledWith(
    res,
    'default',
    'conversation:slack:C123',
  );
});

it('connects projected provider channels after Slack activation', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', {}),
    res,
    ctx,
    '/ui/api/onboarding/provider-candidates/provider-candidate-1/activate',
    settings,
  );

  expect(res.statusCode).toBe(201);
  expect(syncSettingsFromProjection).toHaveBeenCalled();
  expect(connectProjectedChannels).toHaveBeenCalledOnce();
  expect(syncSettingsFromProjection.mock.invocationCallOrder[0]).toBeLessThan(
    connectProjectedChannels.mock.invocationCallOrder[0]!,
  );
});

it('binds a newly discovered Slack human without requiring prior message history', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  onboardingStatus.mockResolvedValue({
    completed: false,
    deployment: {
      agentId: 'agent:atlas',
      providerAccountId: 'slack-account',
    },
  });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', {
      conversationId: 'conversation:slack-account:C123',
      approverExternalUserId: 'U123',
      allowlistExternalUserIds: ['U123'],
    }),
    res,
    ctx,
    '/ui/api/onboarding/assignment',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(listConversationMembers).toHaveBeenCalledWith({
    appId: 'default',
    conversationId: 'conversation:slack-account:C123',
  });
  expect(bindWorkAssignment).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: 'default',
      agentId: 'agent:atlas',
      providerAccountId: 'slack-account',
      approverExternalUserId: 'U123',
      approverDisplayName: 'Ada Lovelace',
      allowlist: [{ externalUserId: 'U123', displayName: 'Ada Lovelace' }],
    }),
  );
});

it('rejects an assignment whose approver is not in the allowlist', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  onboardingStatus.mockResolvedValue({
    completed: false,
    deployment: {
      agentId: 'agent:atlas',
      providerAccountId: 'slack-account',
    },
  });
  listConversationMembers.mockResolvedValue([
    { id: 'U123', displayName: 'Ada Lovelace' },
    { id: 'U456', displayName: 'Grace Hopper' },
  ]);
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', {
      conversationId: 'conversation:slack-account:C123',
      approverExternalUserId: 'U123',
      allowlistExternalUserIds: ['U456'],
    }),
    res,
    ctx,
    '/ui/api/onboarding/assignment',
    settings,
  );

  expect(res.statusCode).toBe(422);
  expect(bindWorkAssignment).not.toHaveBeenCalled();
});

it('rejects an assignment with no allowlist selected', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  onboardingStatus.mockResolvedValue({
    completed: false,
    deployment: {
      agentId: 'agent:atlas',
      providerAccountId: 'slack-account',
    },
  });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', {
      conversationId: 'conversation:slack-account:C123',
      approverExternalUserId: 'U123',
      allowlistExternalUserIds: [],
    }),
    res,
    ctx,
    '/ui/api/onboarding/assignment',
    settings,
  );

  expect(res.statusCode).toBe(400);
  expect(bindWorkAssignment).not.toHaveBeenCalled();
});

it('stages and checks credentials before a model is selected', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  const staged = response();
  await handleBrowserOnboardingRoutes(
    request('POST', {
      providerId: 'anthropic',
      authMode: 'api_key',
      credentials: { api_key: 'secret' },
    }),
    staged,
    ctx,
    '/ui/api/onboarding/model-candidates',
    settings,
  );

  expect(staged.statusCode).toBe(201);
  expect(stageModelCredentialCandidate).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: 'anthropic',
      payload: { api_key: 'secret' },
    }),
  );
  expect(stageModelCredentialCandidate.mock.calls[0]?.[0]).not.toHaveProperty(
    'modelAlias',
  );

  getModelCredentialCandidate.mockResolvedValue(modelCandidate());
  const checked = response();
  await handleBrowserOnboardingRoutes(
    request('POST', {}),
    checked,
    ctx,
    '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/check',
    settings,
  );

  expect(checked.statusCode).toBe(200);
  expect(JSON.parse(checked.body)).toEqual({
    candidate: {
      id: '00000000-0000-4000-8000-000000000001',
      state: 'checked',
    },
  });
  expect(transitionModelCredentialCandidate).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ state: 'validating' }),
  );
  expect(transitionModelCredentialCandidate).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ state: 'checked' }),
  );
});

it('binds the selected model immediately before live verification', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  getModelCredentialCandidate.mockResolvedValue(modelCandidate());
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', { modelAlias: 'Sonnet 4.6' }),
    res,
    ctx,
    '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/verify',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(bindModelSelectionForVerification).toHaveBeenCalledWith(
    expect.objectContaining({
      modelAlias: 'sonnet',
      routeId: 'anthropic',
    }),
  );
  expect(verifyOnboardingModelCredential).toHaveBeenCalledWith(
    expect.objectContaining({ modelAlias: 'sonnet' }),
  );
  expect(JSON.stringify(JSON.parse(res.body))).not.toContain('secret');
});

it('lists canonical model aliases for the authenticated candidate provider', async () => {
  activeSession.mockResolvedValue({ ...session, role: 'administrator' });
  getModelCredentialCandidate.mockResolvedValue(modelCandidate());
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('GET'),
    res,
    ctx,
    '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/models',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).models).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        alias: 'sonnet',
        displayName: 'Sonnet 4.6',
        providerId: 'anthropic',
      }),
    ]),
  );
});

it.each([
  ['anthropic', 'sonnet'],
  ['bedrock', 'bedrock-oss'],
  ['openai', 'gpt'],
  ['openrouter', 'kimi'],
  ['vertex', 'vertex'],
] as const)(
  'returns canonical %s catalog values',
  async (providerId, alias) => {
    activeSession.mockResolvedValue({ ...session, role: 'administrator' });
    getModelCredentialCandidate.mockResolvedValue({
      ...modelCandidate(),
      providerId,
    });
    const res = response();

    await handleBrowserOnboardingRoutes(
      request('GET'),
      res,
      ctx,
      '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/models',
      settings,
    );

    expect(JSON.parse(res.body).models).toEqual(
      expect.arrayContaining([expect.objectContaining({ alias, providerId })]),
    );
  },
);

it('projects the revision committed by employee activation', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  getModelCredentialCandidate.mockResolvedValue({
    ...modelCandidate(),
    state: 'verified',
    modelAlias: 'Sonnet 4.6',
    routeId: 'anthropic',
    verificationExpiresAt: '2099-01-01T00:00:00.000Z',
  });
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', {
      name: 'Atlas',
      title: 'General assistant',
      responsibilities: 'Answer questions.',
    }),
    res,
    ctx,
    '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/activate',
    settings,
  );

  expect(res.statusCode).toBe(201);
  expect(ctx.syncSettingsFromProjection).toHaveBeenCalledWith('default', {
    requiredRevision: 2,
  });
  expect(recordProjectionReceipt).toHaveBeenCalledWith({
    appId: 'default',
    revision: 2,
    status: 'applied',
  });
});

it('reports a rejected provider credential without exposing it', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  getModelCredentialCandidate.mockResolvedValue(modelCandidate());
  verifyOnboardingModelCredential.mockRejectedValue(
    new Error('Anthropic rejected the credentials.'),
  );
  isModelCredentialRejectedError.mockReturnValue(true);
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', { modelAlias: 'Sonnet 4.6' }),
    res,
    ctx,
    '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/verify',
    settings,
  );

  expect(res.statusCode).toBe(422);
  expect(JSON.parse(res.body)).toMatchObject({
    error: {
      code: 'MODEL_PROBE_FAILED',
      details: {
        checks: [
          { id: 'credentials', status: 'fail' },
          { id: 'route', status: 'pass' },
          { id: 'inference', status: 'fail' },
        ],
      },
    },
  });
  expect(res.body).not.toContain('secret');
});

it('rejects a model owned by another provider before inference', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    ...session,
    role: 'administrator',
  });
  getModelCredentialCandidate.mockResolvedValue(modelCandidate());
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('POST', { modelAlias: 'GPT-5.5' }),
    res,
    ctx,
    '/ui/api/onboarding/model-candidates/00000000-0000-4000-8000-000000000001/verify',
    settings,
  );

  expect(res.statusCode).toBe(400);
  expect(bindModelSelectionForVerification).not.toHaveBeenCalled();
  expect(verifyOnboardingModelCredential).not.toHaveBeenCalled();
});

function modelCandidate() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    appId: session.appId,
    userId: session.userId,
    providerId: 'anthropic',
    authMode: 'api_key',
    modelAlias: null,
    routeId: null,
    payload: { api_key: 'secret' },
    schemaVersion: 1,
    state: 'checked',
    requestHash: 'request-hash',
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-09-19T00:00:00.000Z',
  };
}

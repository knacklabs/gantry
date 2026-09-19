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
const verifyOnboardingModelCredential = vi.hoisted(() => vi.fn());

vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  activeSession,
  requireBrowserMutationSession,
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ service: { db: {} } }),
}));
vi.mock(
  '@core/application/onboarding/model-credential-verification.js',
  () => ({ verifyOnboardingModelCredential }),
);
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
const ctx = { syncSettingsFromProjection: vi.fn() } as never;

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
      modelAlias: 'Sonnet 4.6',
      routeId: 'anthropic',
    }),
  );
  expect(verifyOnboardingModelCredential).toHaveBeenCalledWith(
    expect.objectContaining({ modelAlias: 'Sonnet 4.6' }),
  );
  expect(JSON.stringify(JSON.parse(res.body))).not.toContain('secret');
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

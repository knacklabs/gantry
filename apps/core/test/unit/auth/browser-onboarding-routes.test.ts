import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, expect, it, vi } from 'vitest';

const activeSession = vi.hoisted(() => vi.fn());
const requireBrowserMutationSession = vi.hoisted(() => vi.fn());
const onboardingCompletedAt = vi.hoisted(() => vi.fn());
const markOnboardingCompleted = vi.hoisted(() => vi.fn());

vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  activeSession,
  requireBrowserMutationSession,
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ service: { db: {} } }),
}));
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
} from '@core/control/server/routes/browser-onboarding.js';

const settings = {
  authentication: {
    mode: 'local' as const,
    canonicalOrigin: 'http://127.0.0.1:3939',
  },
};
const session = { appId: 'default', userId: 'local-console:default' };

function request(method: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.headers = {};
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

beforeEach(() => vi.resetAllMocks());

it('reads completion for the authenticated user only', async () => {
  activeSession.mockResolvedValue(session);
  onboardingCompletedAt.mockResolvedValue(null);
  const res = response();

  await handleBrowserOnboardingRoutes(
    request('GET'),
    res,
    '/ui/api/onboarding/status',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ completed: false });
  expect(onboardingCompletedAt).toHaveBeenCalledWith(session);
});

it('requires the standard mutation session before completing onboarding', async () => {
  requireBrowserMutationSession.mockResolvedValue(null);
  const denied = response();

  await handleBrowserOnboardingRoutes(
    request('POST'),
    denied,
    '/ui/api/onboarding/complete',
    settings,
  );
  expect(markOnboardingCompleted).not.toHaveBeenCalled();

  requireBrowserMutationSession.mockResolvedValue(session);
  const accepted = response();
  await handleBrowserOnboardingRoutes(
    request('POST'),
    accepted,
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
  expect(isBrowserOnboardingPath('/ui/api/onboarding/complete')).toBe(true);
  expect(isBrowserOnboardingPath('/ui/api/onboarding')).toBe(false);
});

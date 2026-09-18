import type { IncomingMessage, ServerResponse } from 'node:http';

import { PostgresAuthenticationRepository } from '../../../adapters/storage/postgres/repositories/authentication-repository.postgres.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { nowIso } from '../../../shared/time/datetime.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { sendError, sendJson } from '../http.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

const ONBOARDING_STATUS_PATH = '/ui/api/onboarding/status';
const ONBOARDING_COMPLETE_PATH = '/ui/api/onboarding/complete';

type BrowserOnboardingSettings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

export function isBrowserOnboardingPath(pathname: string): boolean {
  return (
    pathname === ONBOARDING_STATUS_PATH || pathname === ONBOARDING_COMPLETE_PATH
  );
}

export async function handleBrowserOnboardingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  settings: BrowserOnboardingSettings,
): Promise<boolean> {
  if (!isBrowserOnboardingPath(pathname)) return false;
  const mode = settings.authentication.mode;
  const repository = new PostgresAuthenticationRepository(
    getRuntimeStorage().service.db,
  );

  if (pathname === ONBOARDING_STATUS_PATH) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return true;
    }
    const session = await activeSession(req, mode);
    if (!session) {
      sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
      return true;
    }
    const completedAt = await repository.onboardingCompletedAt(session);
    sendJson(res, 200, { completed: completedAt !== null });
    return true;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return true;
  await repository.markOnboardingCompleted({ ...session, now: nowIso() });
  sendJson(res, 200, { completed: true });
  return true;
}

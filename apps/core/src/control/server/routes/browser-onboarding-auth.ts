import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ModelProviderPreflightSettings } from '../../../adapters/llm/model-provider-preflight.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { sendError } from '../http.js';
import { requireBrowserMutationSession } from './browser-auth.js';

export type BrowserOnboardingSettings = ModelProviderPreflightSettings & {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

export async function requireOnboardingAdministrator(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserOnboardingSettings,
) {
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode: settings.authentication.mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return null;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return null;
  }
  if (
    settings.authentication.mode === 'hosted' &&
    !isRecentlyReauthenticated(session.reauthenticatedAt)
  ) {
    sendError(
      res,
      401,
      'REAUTHENTICATION_REQUIRED',
      'Sign in again to continue.',
    );
    return null;
  }
  return session;
}

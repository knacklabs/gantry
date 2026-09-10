import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { sendError, sendJson } from '../http.js';
import { activeSession } from './browser-auth.js';

const ONBOARDING_STATUS_PATH = '/ui/api/onboarding/status';

type Settings = { authentication: { mode: 'local' | 'hosted' } };

export function isBrowserOnboardingPath(pathname: string) {
  return pathname === ONBOARDING_STATUS_PATH;
}

export async function handleBrowserOnboardingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  settings: Settings,
): Promise<boolean> {
  if (!isBrowserOnboardingPath(pathname)) return false;
  if (req.method !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }
  const storage = getRuntimeStorage();
  const agents = await storage.repositories.agents.listAgents(
    session.appId as AppId,
  );
  const accounts =
    await storage.repositories.providerAccounts.listProviderAccounts(
      session.appId as AppId,
    );
  const resumable = agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      hasWorkspace: accounts.some((account) => account.agentId === agent.id),
    }))
    .filter((agent) => !agent.hasWorkspace);
  sendJson(res, 200, {
    firstRun: agents.length === 0,
    resume: resumable[0] ?? null,
  });
  return true;
}

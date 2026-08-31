import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { sendError, sendJson } from '../http.js';
import { activeSession } from './browser-auth.js';

type BrowserNavigationSummarySettings = {
  authentication: { mode: 'local' | 'hosted' };
};

const NAVIGATION_SUMMARY_PATH = '/ui/api/navigation-summary';

export function isBrowserNavigationSummaryPath(pathname: string): boolean {
  return pathname === NAVIGATION_SUMMARY_PATH;
}

export async function handleBrowserNavigationSummary(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserNavigationSummarySettings,
): Promise<boolean> {
  if (!isBrowserNavigationSummaryPath(pathname)) return false;
  if (req.method !== 'GET') return false;

  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  const role = session.role as ConsoleRole;
  const canSeeAdministratorCounts = browserRoleAllowsScope(
    role,
    'agents:admin',
  );
  if (
    !canSeeAdministratorCounts &&
    !browserRoleAllowsScope(role, 'skills:read')
  ) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }

  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  if (!canSeeAdministratorCounts) {
    sendJson(res, 200, { skills: await summarizeSkills(storage, appId) });
    return true;
  }
  const [agents, servers, providers, skills] = await Promise.all([
    summarizeAgents(storage, appId),
    summarizeMcpServers(storage, appId),
    new ModelCredentialService(storage.repositories.modelCredentials).list({
      appId,
    }),
    summarizeSkills(storage, appId),
  ]);
  sendJson(res, 200, {
    agents,
    mcpServers: servers,
    skills,
    modelProviders: {
      ready: providers.filter((provider) => provider.health === 'ready').length,
      missing: providers.filter((provider) => provider.health === 'missing')
        .length,
      disabled: providers.filter((provider) => provider.health === 'disabled')
        .length,
    },
  });
  return true;
}

async function summarizeSkills(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
) {
  if (storage.repositories.skills.summarizeNavigation) {
    return storage.repositories.skills.summarizeNavigation(appId);
  }
  const skills = await storage.repositories.skills.listSkills({
    appId,
    statuses: ['installed'],
  });
  return { installed: skills.length };
}

async function summarizeAgents(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
) {
  if (storage.repositories.agents.summarizeNavigation) {
    return storage.repositories.agents.summarizeNavigation(appId);
  }
  const agents = await storage.repositories.agents.listAgents(appId);
  const configs = await Promise.all(
    agents.map((agent) =>
      agent.currentConfigVersionId
        ? storage.repositories.agentConfigs.getConfigVersion(
            agent.currentConfigVersionId,
          )
        : null,
    ),
  );
  return {
    total: agents.length,
    active: agents.filter((agent) => agent.status === 'active').length,
    disabled: agents.filter((agent) => agent.status === 'disabled').length,
    withoutRole: configs.filter((config) => !config?.roleSnapshot).length,
  };
}

async function summarizeMcpServers(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
) {
  if (storage.repositories.mcpServers.summarizeNavigation) {
    return storage.repositories.mcpServers.summarizeNavigation(appId);
  }
  const servers = await storage.repositories.mcpServers.listServers({
    appId,
    limit: 500,
  });
  return {
    active: servers.filter((server) => server.status === 'active').length,
    disabled: servers.filter((server) => server.status === 'disabled').length,
  };
}

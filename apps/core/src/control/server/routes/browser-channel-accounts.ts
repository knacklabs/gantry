import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { BuiltInControlChannelProviderCatalog } from '../../../channels/control-provider-catalog.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { sendError, sendJson } from '../http.js';
import { activeSession } from './browser-auth.js';

type BrowserChannelAccountSettings = {
  authentication: { mode: 'local' | 'hosted' };
};

const CHANNEL_PROVIDERS_PATH = '/ui/api/channel-providers';
const CHANNEL_ACCOUNTS_PATH = '/ui/api/channel-accounts';
const CONVERSATIONS_PATH = '/ui/api/conversations';
const AGENT_INSTALLS_PATH = /^\/ui\/api\/agents\/([^/]+)\/conversation-installs$/;

export function isBrowserChannelAccountsPath(pathname: string): boolean {
  return (
    pathname === CHANNEL_PROVIDERS_PATH ||
    pathname === CHANNEL_ACCOUNTS_PATH ||
    pathname === CONVERSATIONS_PATH ||
    AGENT_INSTALLS_PATH.test(pathname)
  );
}

export async function handleBrowserChannelAccountRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  settings: BrowserChannelAccountSettings,
): Promise<boolean> {
  if (!isBrowserChannelAccountsPath(pathname)) return false;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  const appId = session.appId as AppId;
  const role = session.role as ConsoleRole;
  const needsAgentAdministration = AGENT_INSTALLS_PATH.test(pathname);
  const requiredScope = needsAgentAdministration
    ? 'agents:admin'
    : pathname === CONVERSATIONS_PATH
      ? 'conversations:read'
      : 'providers:read';
  if (!browserRoleAllowsScope(role, requiredScope)) {
    sendError(
      res,
      403,
      'FORBIDDEN',
      needsAgentAdministration
        ? 'Administrator access is required.'
        : 'Viewer access is required.',
    );
    return true;
  }

  const storage = getRuntimeStorage();
  if (pathname === CHANNEL_PROVIDERS_PATH) {
    const providers = new BuiltInControlChannelProviderCatalog().listProviders();
    sendJson(res, 200, {
      providers: providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilityFlags,
        credentialKeys: provider.allowedRuntimeSecretKeys ?? [],
        status: provider.capabilityFlags.includes('placeholder')
          ? 'unavailable'
          : provider.capabilityFlags.includes('runtime-placeholder')
            ? 'setup_only'
            : 'available',
      })),
    });
    return true;
  }
  if (pathname === CHANNEL_ACCOUNTS_PATH) {
    const accounts = await storage.repositories.providerAccounts.listProviderAccounts(
      appId,
    );
    sendJson(res, 200, {
      accounts: accounts.map((account) => ({
        id: account.id,
        agentId: account.agentId,
        providerId: account.providerId,
        label: account.label,
        status: account.status,
        credentialKeys: Object.keys(account.runtimeSecretRefs).sort(),
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })),
    });
    return true;
  }
  if (pathname === CONVERSATIONS_PATH) {
    const conversations = await storage.repositories.conversations.listConversations(
      { appId },
    );
    sendJson(res, 200, {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        providerAccountId: conversation.providerAccountId,
        kind: conversation.kind,
        title: conversation.title ?? null,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      })),
    });
    return true;
  }
  const match = pathname.match(AGENT_INSTALLS_PATH);
  if (!match) {
    sendError(res, 404, 'NOT_FOUND', 'Browser channel account route not found.');
    return true;
  }
  const agentId = decodeURIComponent(match[1]!) as AgentId;
  const agent = await storage.repositories.agents.getAgent(agentId);
  if (!agent || agent.appId !== appId) {
    sendError(res, 404, 'NOT_FOUND', 'Agent not found.');
    return true;
  }
  const installs = await storage.repositories.providerAccounts.listConversationInstalls(
    appId,
    agentId,
  );
  sendJson(res, 200, {
    installs: installs.map((install) => ({
      id: install.id,
      providerAccountId: install.providerAccountId,
      conversationId: install.conversationId,
      threadId: install.threadId ?? null,
      displayName: install.displayName,
      status: install.status,
      memoryScope: install.memoryScope,
      createdAt: install.createdAt,
      updatedAt: install.updatedAt,
    })),
  });
  return true;
}

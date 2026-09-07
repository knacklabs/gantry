import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { CapabilitySecretService } from '../../../application/capability-secrets/capability-secret-service.js';
import { ProviderAccountControlService } from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { BuiltInControlChannelProviderCatalog } from '../../../channels/control-provider-catalog.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { gantryRuntimeSecretRef } from '../../../domain/ports/runtime-secret-provider.js';
import { runtimeSecretNameForProviderAccount } from '../../../domain/provider/provider-runtime-secret-keys.js';
import type { ProviderId } from '../../../domain/provider/provider.js';
import { nowIso } from '../app-identity.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import { systemPrincipal } from '../../../domain/identity/principal-ref.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import {
  readJson,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

type BrowserChannelAccountSettings = {
  authentication: {
    mode: 'local' | 'hosted';
    canonicalOrigin: string;
  };
};

const CHANNEL_PROVIDERS_PATH = '/ui/api/channel-providers';
const CHANNEL_ACCOUNTS_PATH = '/ui/api/channel-accounts';
const CONVERSATIONS_PATH = '/ui/api/conversations';
const AGENT_INSTALLS_PATH =
  /^\/ui\/api\/agents\/([^/]+)\/conversation-installs$/;

type AccountCreationBody = {
  agentId: string;
  providerId: string;
  label: string;
  credentials: Record<string, string>;
};

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
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserChannelAccountSettings,
): Promise<boolean> {
  if (!isBrowserChannelAccountsPath(pathname)) return false;
  const canCreate = pathname === CHANNEL_ACCOUNTS_PATH && req.method === 'POST';
  if (req.method !== 'GET' && !canCreate) {
    res.setHeader(
      'Allow',
      pathname === CHANNEL_ACCOUNTS_PATH ? 'GET, POST' : 'GET',
    );
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }
  if (canCreate) {
    return await createBrowserChannelAccount(req, res, ctx, settings);
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
    const providers =
      new BuiltInControlChannelProviderCatalog().listProviders();
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
    const accounts =
      await storage.repositories.providerAccounts.listProviderAccounts(appId);
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
    const conversations =
      await storage.repositories.conversations.listConversations({ appId });
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
    sendError(
      res,
      404,
      'NOT_FOUND',
      'Browser channel account route not found.',
    );
    return true;
  }
  const agentId = decodeURIComponent(match[1]!) as AgentId;
  const agent = await storage.repositories.agents.getAgent(agentId);
  if (!agent || agent.appId !== appId) {
    sendError(res, 404, 'NOT_FOUND', 'Agent not found.');
    return true;
  }
  const installs =
    await storage.repositories.providerAccounts.listConversationInstalls(
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

async function createBrowserChannelAccount(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  settings: BrowserChannelAccountSettings,
): Promise<boolean> {
  const authentication = settings.authentication;
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode: authentication.mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      authentication.canonicalOrigin,
    ),
  });
  if (!session) return true;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'providers:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }
  if (
    authentication.mode === 'hosted' &&
    !isRecentlyReauthenticated(session.reauthenticatedAt)
  ) {
    sendError(
      res,
      401,
      'REAUTHENTICATION_REQUIRED',
      'Sign in again to continue.',
    );
    return true;
  }
  const body = await readAccountCreationBody(req, res);
  if (!body) return true;
  const catalog = new BuiltInControlChannelProviderCatalog();
  const provider = catalog
    .listProviders()
    .find((candidate) => candidate.id === body.providerId);
  if (!provider || provider.capabilityFlags.includes('placeholder')) {
    sendError(res, 400, 'INVALID_PROVIDER', 'This provider is not available.');
    return true;
  }
  const credentialKeys = provider.allowedRuntimeSecretKeys ?? [];
  if (
    credentialKeys.length !== Object.keys(body.credentials).length ||
    credentialKeys.some((key) => !body.credentials[key])
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Enter every required provider credential.',
    );
    return true;
  }
  const appId = session.appId as AppId;
  const storage = getRuntimeStorage();
  const providerAccounts = new ProviderAccountControlService({
    agents: storage.repositories.agents,
    providerAccounts: storage.repositories.providerAccounts,
    providers: catalog,
    ids: { generate: randomUUID },
    clock: { now: nowIso },
  });
  try {
    const account = await providerAccounts.create({
      appId,
      agentId: body.agentId as AgentId,
      providerId: body.providerId as ProviderId,
      label: body.label,
      enabled: false,
    });
    const actor = {
      kind: 'human' as const,
      personId: session.userId,
    };
    const secrets = new CapabilitySecretService(
      storage.repositories.capabilitySecrets,
      (event) => storage.runtimeEvents.publish(event),
    );
    const runtimeSecretRefs = Object.fromEntries(
      await Promise.all(
        credentialKeys.map(async (key) => {
          const name = runtimeSecretNameForProviderAccount(
            body.providerId,
            account.id,
            key,
          );
          await secrets.set({
            appId,
            name,
            value: body.credentials[key]!,
            actor,
          });
          return [key, gantryRuntimeSecretRef(name)];
        }),
      ),
    );
    const updated = await providerAccounts.update({
      appId,
      providerAccountId: account.id,
      patch: {
        runtimeSecretRefs,
        enabled: !provider.capabilityFlags.includes('runtime-placeholder'),
      },
    });
    await ctx.syncSettingsFromProjection(appId, {
      providerAccount: { id: updated.id, runtimeSecretRefs },
    });
    sendJson(res, 201, {
      account: {
        id: updated.id,
        agentId: updated.agentId,
        providerId: updated.providerId,
        label: updated.label,
        status: updated.status,
        credentialKeys: Object.keys(updated.runtimeSecretRefs).sort(),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
  return true;
}

async function readAccountCreationBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AccountCreationBody | null> {
  let value: unknown;
  try {
    value = await readJson(req);
  } catch {
    sendError(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    return null;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['agentId', 'providerId', 'label', 'credentials'].includes(key),
    )
  ) {
    sendError(res, 400, 'INVALID_REQUEST', 'Unsupported account fields.');
    return null;
  }
  if (
    typeof value.agentId !== 'string' ||
    !value.agentId.trim() ||
    typeof value.providerId !== 'string' ||
    !value.providerId.trim() ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    !isRecord(value.credentials) ||
    Object.values(value.credentials).some(
      (credential) => typeof credential !== 'string' || !credential.trim(),
    )
  ) {
    sendError(res, 400, 'INVALID_REQUEST', 'Account details are incomplete.');
    return null;
  }
  return {
    agentId: value.agentId.trim(),
    providerId: value.providerId.trim(),
    label: value.label.trim(),
    credentials: value.credentials as Record<string, string>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

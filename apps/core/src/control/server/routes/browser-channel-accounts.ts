import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { CapabilitySecretService } from '../../../application/capability-secrets/capability-secret-service.js';
import { ConversationAdministrationService } from '../../../application/provider-conversations/conversation-administration-service.js';
import {
  ConversationInstallControlService,
  DiscoverProviderConversationsService,
  ProviderAccountControlService,
} from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import { createRepositoryRuntimeSecretProvider } from '../../../adapters/credentials/repository-runtime-secret-provider.js';
import { BuiltInControlChannelProviderCatalog } from '../../../channels/control-provider-catalog.js';
import { RuntimeSecretConversationDiscovery } from '../../../channels/control-provider-catalog.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ConversationId } from '../../../domain/conversation/conversation.js';
import {
  gantryRuntimeSecretRef,
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../../../domain/ports/runtime-secret-provider.js';
import { runtimeSecretNameForProviderAccount } from '../../../domain/provider/provider-runtime-secret-keys.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '../../../domain/provider/provider.js';
import { nowIso } from '../app-identity.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { sendApplicationError, sendError, sendJson } from '../http.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';
import {
  createBrowserConversationAdministrationService,
  sendBrowserConversationMembers,
} from './browser-conversation-members.js';
import {
  readAccountCreationBody,
  readApproverIds,
  readConversationInstallBody,
} from './browser-channel-account-dtos.js';

type BrowserChannelAccountSettings = {
  authentication: {
    mode: 'local' | 'hosted';
    canonicalOrigin: string;
  };
  credentialBroker?: { mode: 'none' | 'gantry' };
};

const CHANNEL_PROVIDERS_PATH = '/ui/api/channel-providers';
const CHANNEL_ACCOUNTS_PATH = '/ui/api/channel-accounts';
const CONVERSATIONS_PATH = '/ui/api/conversations';
const AGENT_INSTALLS_PATH =
  /^\/ui\/api\/agents\/([^/]+)\/conversation-installs$/;
const ACCOUNT_DISCOVERY_PATH =
  /^\/ui\/api\/channel-accounts\/([^/]+)\/discover-conversations$/;
const AGENT_INSTALL_PATH =
  /^\/ui\/api\/agents\/([^/]+)\/conversation-installs\/([^/]+)$/;
const CONVERSATION_APPROVERS_PATH =
  /^\/ui\/api\/conversations\/([^/]+)\/approvers(?:\/(verify))?$/;
const CONVERSATION_MEMBERS_PATH =
  /^\/ui\/api\/conversations\/([^/]+)\/members$/;

export function isBrowserChannelAccountsPath(pathname: string): boolean {
  return (
    pathname === CHANNEL_PROVIDERS_PATH ||
    pathname === CHANNEL_ACCOUNTS_PATH ||
    pathname === CONVERSATIONS_PATH ||
    AGENT_INSTALLS_PATH.test(pathname) ||
    ACCOUNT_DISCOVERY_PATH.test(pathname) ||
    AGENT_INSTALL_PATH.test(pathname) ||
    CONVERSATION_APPROVERS_PATH.test(pathname) ||
    CONVERSATION_MEMBERS_PATH.test(pathname)
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
  const canDiscover =
    ACCOUNT_DISCOVERY_PATH.test(pathname) && req.method === 'POST';
  const canInstall = AGENT_INSTALL_PATH.test(pathname) && req.method === 'PUT';
  const approversMatch = pathname.match(CONVERSATION_APPROVERS_PATH);
  const canUpdateApprovers =
    Boolean(approversMatch) &&
    req.method === (approversMatch?.[2] ? 'POST' : 'PUT');
  if (
    req.method !== 'GET' &&
    !canCreate &&
    !canDiscover &&
    !canInstall &&
    !canUpdateApprovers
  ) {
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
  if (canDiscover) {
    return await discoverBrowserConversations(
      req,
      res,
      ctx,
      pathname,
      settings,
    );
  }
  if (canInstall) {
    return await installBrowserConversation(req, res, ctx, pathname, settings);
  }
  if (canUpdateApprovers) {
    return await updateBrowserConversationApprovers(
      req,
      res,
      ctx,
      pathname,
      settings,
    );
  }
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  const appId = session.appId as AppId;
  const role = session.role as ConsoleRole;
  const needsAgentAdministration =
    AGENT_INSTALLS_PATH.test(pathname) ||
    AGENT_INSTALL_PATH.test(pathname) ||
    CONVERSATION_MEMBERS_PATH.test(pathname);
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
  const approverSummaryMatch = pathname.match(CONVERSATION_APPROVERS_PATH);
  if (approverSummaryMatch && !approverSummaryMatch[2]) {
    const conversationId = decodeURIComponent(
      approverSummaryMatch[1]!,
    ) as ConversationId;
    try {
      const summary = await new ConversationAdministrationService({
        providerAccounts: storage.repositories.providerAccounts,
        conversations: storage.repositories.conversations,
      }).getAdminSummary({ appId, conversationId });
      sendJson(res, 200, { approvers: summary.controlAllowlist.userIds });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  const membersMatch = pathname.match(CONVERSATION_MEMBERS_PATH);
  if (membersMatch) {
    const conversationId = decodeURIComponent(
      membersMatch[1]!,
    ) as ConversationId;
    await sendBrowserConversationMembers(res, appId, conversationId);
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
  const referenceValues = credentialKeys.filter((key) =>
    /^(?:env|aws-sm|gantry-secret):/.test(body.credentials[key]!.trim()),
  );
  try {
    if (
      referenceValues.some(
        (key) =>
          parseRuntimeSecretRefString(body.credentials[key]!).source ===
          'gantry-secret',
      )
    ) {
      sendError(
        res,
        400,
        'INVALID_RUNTIME_SECRET_REFERENCE',
        'Browser requests cannot claim an existing Gantry secret reference.',
      );
      return true;
    }
    referenceValues.forEach((key) =>
      normalizeRuntimeSecretRefString(body.credentials[key]!),
    );
  } catch {
    sendError(
      res,
      400,
      'INVALID_RUNTIME_SECRET_REFERENCE',
      'The runtime secret reference is invalid.',
    );
    return true;
  }
  if (
    referenceValues.length > 0 &&
    settings.credentialBroker?.mode !== 'gantry'
  ) {
    sendError(
      res,
      409,
      'RUNTIME_SECRET_REFERENCE_POLICY_DISABLED',
      'Runtime secret references are disabled by policy.',
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
          const credential = body.credentials[key]!.trim();
          if (/^(?:env|aws-sm|gantry-secret):/.test(credential)) {
            return [key, normalizeRuntimeSecretRefString(credential)];
          }
          const name = runtimeSecretNameForProviderAccount(
            body.providerId,
            account.id,
            key,
          );
          await secrets.set({
            appId,
            name,
            value: credential,
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

async function discoverBrowserConversations(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserChannelAccountSettings,
): Promise<boolean> {
  const session = await requireChannelAccountAdministrator(req, res, settings);
  if (!session) return true;
  const match = pathname.match(ACCOUNT_DISCOVERY_PATH);
  if (!match) return true;
  const appId = session.appId as AppId;
  const storage = getRuntimeStorage();
  const providerAccountId = decodeURIComponent(match[1]!) as ProviderAccountId;
  try {
    const discovery = new DiscoverProviderConversationsService({
      providerAccounts: storage.repositories.providerAccounts,
      conversations: storage.repositories.conversations,
      discovery: new RuntimeSecretConversationDiscovery(
        createRepositoryRuntimeSecretProvider({
          appId,
          repository: storage.repositories.capabilitySecrets,
        }),
      ),
      ids: { generate: randomUUID },
      clock: { now: nowIso },
    });
    const conversations = await discovery.execute({ appId, providerAccountId });
    if (conversations.length === 0) {
      sendError(
        res,
        409,
        'NO_SUPPORTED_CONVERSATIONS',
        'No supported conversations were discovered for this account.',
      );
      return true;
    }
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
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
  return true;
}

async function installBrowserConversation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserChannelAccountSettings,
): Promise<boolean> {
  const session = await requireChannelAccountAdministrator(req, res, settings);
  if (!session) return true;
  const match = pathname.match(AGENT_INSTALL_PATH);
  if (!match) return true;
  const body = await readConversationInstallBody(req, res);
  if (!body) return true;
  const appId = session.appId as AppId;
  const storage = getRuntimeStorage();
  const agentId = decodeURIComponent(match[1]!) as AgentId;
  const conversationId = decodeURIComponent(match[2]!) as ConversationId;
  try {
    const conversation =
      await storage.repositories.conversations.getConversation(conversationId);
    const directCounterparts =
      conversation?.kind === 'direct'
        ? await storage.repositories.conversations.listParticipantExternalUserIds(
            conversationId,
          )
        : [];
    if (conversation?.kind === 'direct' && directCounterparts.length !== 1) {
      sendError(
        res,
        409,
        'DIRECT_MESSAGE_COUNTERPART_UNRESOLVED',
        'The direct-message counterpart could not be resolved.',
      );
      return true;
    }
    const install = await new ConversationInstallControlService({
      agents: storage.repositories.agents,
      providerAccounts: storage.repositories.providerAccounts,
      conversations: storage.repositories.conversations,
      ids: { generate: randomUUID },
      clock: { now: nowIso },
    }).enable({
      appId,
      agentId,
      conversationId,
      patch: {
        providerAccountId: body.providerAccountId as ProviderAccountId,
        memoryScope: body.memoryScope,
      },
    });
    if (conversation?.kind === 'direct') {
      await storage.repositories.conversations.replaceConversationApprovers({
        appId,
        conversationId,
        externalUserIds: directCounterparts,
        updatedAt: nowIso(),
      });
    }
    await ctx.syncSettingsFromProjection(appId);
    sendJson(res, 201, {
      install: {
        id: install.id,
        agentId: install.agentId,
        providerAccountId: install.providerAccountId,
        conversationId: install.conversationId,
        displayName: install.displayName,
        status: install.status,
        memoryScope: install.memoryScope,
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
      },
    });
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
  return true;
}

async function updateBrowserConversationApprovers(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserChannelAccountSettings,
): Promise<boolean> {
  const session = await requireChannelAccountAdministrator(req, res, settings);
  if (!session) return true;
  const match = pathname.match(CONVERSATION_APPROVERS_PATH);
  if (!match) return true;
  const userIds = await readApproverIds(req, res);
  if (!userIds) return true;
  const appId = session.appId as AppId;
  const conversationId = decodeURIComponent(match[1]!) as ConversationId;
  try {
    const service = createBrowserConversationAdministrationService(appId);
    if (match[2]) {
      sendJson(res, 200, {
        verification: await service.validateControlAllowlist({
          appId,
          conversationId,
          userIds,
        }),
      });
      return true;
    }
    const result = await service.replaceControlAllowlist({
      appId,
      conversationId,
      userIds,
      updatedAt: nowIso(),
    });
    await ctx.syncSettingsFromProjection(appId);
    sendJson(res, 200, { approvers: result });
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
  return true;
}

async function requireChannelAccountAdministrator(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserChannelAccountSettings,
) {
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
  if (!session) return null;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'providers:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return null;
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
    return null;
  }
  return session;
}

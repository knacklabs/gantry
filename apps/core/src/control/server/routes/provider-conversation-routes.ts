import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ConversationApproverPutRequestSchema,
  ConversationInstallRequestSchema,
  CreateProviderAccountRequestSchema,
  DiscoverProviderAccountRequestSchema,
  UpdateProviderAccountRequestSchema,
} from '@gantry/contracts';

import { createRepositoryRuntimeSecretProvider } from '../../../adapters/credentials/repository-runtime-secret-provider.js';
import { RuntimeSecretConversationMembershipValidator } from '../../../channels/conversation-membership-validation.js';
import {
  BuiltInControlChannelProviderCatalog,
  RuntimeSecretConversationDiscovery,
} from '../../../channels/control-provider-catalog.js';
import { ConversationAdministrationService } from '../../../application/provider-conversations/conversation-administration-service.js';
import {
  ConversationInstallControlService,
  ProviderAccountControlService,
  DiscoverProviderConversationsService,
} from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import { ListProvidersUseCase } from '../../../application/provider-conversations/list-providers-use-case.js';
import { ConversationControlService } from '../../../application/conversations/conversation-control-use-cases.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '../../../domain/provider/provider.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../../../domain/conversation/conversation.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { nowIso } from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import {
  readJson,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import {
  parseConversationInstallRoute,
  parseProviderAccountRoute,
  parseConversationRoute,
} from '../route-parser.js';
import {
  conversationInstallPatchFromParsed,
  conversationInstallToResponse,
  conversationToResponse,
  externalRefFromContract,
  messageToResponse,
  parseLimit,
  providerAccountToResponse,
  providerToResponse,
  threadToResponse,
} from './provider-conversation-mappers.js';
import {
  projectConversationInstallToRuntime,
  projectProviderAccountRoutesToRuntime,
  removeProviderAccountRoutesFromRuntime,
  removeConversationInstallFromRuntime,
} from './provider-conversation-live-routes.js';

const providers = new BuiltInControlChannelProviderCatalog();

function services(appId: AppId = 'default' as AppId) {
  const repositories = getRuntimeStorage().repositories;
  const ids = { generate: randomUUID };
  const clock = { now: nowIso };
  const runtimeSecrets = createRepositoryRuntimeSecretProvider({
    appId,
    repository: repositories.capabilitySecrets,
  });
  return {
    providerAccounts: new ProviderAccountControlService({
      agents: repositories.agents,
      providerAccounts: repositories.providerAccounts,
      providers,
      ids,
      clock,
    }),
    discovery: new DiscoverProviderConversationsService({
      providerAccounts: repositories.providerAccounts,
      conversations: repositories.conversations,
      discovery: new RuntimeSecretConversationDiscovery(runtimeSecrets),
      ids,
      clock,
    }),
    conversations: new ConversationControlService({
      conversations: repositories.conversations,
      messages: repositories.messages,
    }),
    conversationInstalls: new ConversationInstallControlService({
      agents: repositories.agents,
      providerAccounts: repositories.providerAccounts,
      conversations: repositories.conversations,
      ids,
      clock,
    }),
  };
}

function parseConversationInstallPatch(
  appId: AppId,
  conversationId: ConversationId,
  raw: unknown,
) {
  const parsed = ConversationInstallRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return conversationInstallPatchFromParsed(appId, conversationId, parsed.data);
}

export async function handleProviderConversationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  // Compatibility route for Agent.Tender thread replies. Migrate this caller to
  // the provider-account/conversation-install delivery surface before removal.
  if (
    pathname === '/v1/providers/teams/thread-replies' &&
    req.method === 'POST'
  ) {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:admin',
    ]);
    if (!auth) return true;
    const body = await readJson(req);
    const parsed = parseTeamsThreadReplyRequest(body);
    if (!parsed) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid Teams thread reply request',
      );
      return true;
    }
    const threadConversationId = teamsThreadConversationId(
      parsed.conversationId,
      parsed.replyToId,
    );
    const result = await ctx.app.sendChannelMessage(
      normalizeTeamsJid(threadConversationId),
      parsed.text,
      { durability: 'best_effort' },
    );
    sendJson(res, 202, {
      accepted: true,
      conversationId: parsed.conversationId,
      replyToId: parsed.replyToId,
      teamsConversationId: threadConversationId,
      teamsMessageId:
        result?.externalMessageId ?? result?.externalMessageIds?.[0] ?? null,
    });
    return true;
  }

  if (pathname === '/v1/providers' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:read',
    ]);
    if (!auth) return true;
    const result = await new ListProvidersUseCase(providers).execute();
    sendJson(res, 200, {
      providers: result.providers.map(providerToResponse),
    });
    return true;
  }

  if (pathname === '/v1/provider-accounts' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:read',
    ]);
    if (!auth) return true;
    const result = await services().providerAccounts.list(auth.appId as AppId);
    sendJson(res, 200, {
      providerAccounts: result.map(providerAccountToResponse),
    });
    return true;
  }

  if (pathname === '/v1/provider-accounts' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    const parsed = CreateProviderAccountRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid provider account');
      return true;
    }
    if (parsed.data.appId !== auth.appId) {
      sendError(
        res,
        403,
        'FORBIDDEN',
        'API key cannot create provider accounts for this app',
      );
      return true;
    }
    try {
      const providerAccount = await services().providerAccounts.create({
        appId: auth.appId as AppId,
        agentId: parsed.data.agentId as AgentId,
        providerId: parsed.data.providerId as ProviderId,
        label: parsed.data.label,
        config: parsed.data.config,
        externalInstallationRef: externalRefFromContract(
          parsed.data.externalRef,
          'provider_account',
        ),
        runtimeSecretRefs: parsed.data.runtimeSecretRefs,
        enabled: parsed.data.enabled,
      });
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 201, providerAccountToResponse(providerAccount));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const providerAccountRoute = parseProviderAccountRoute(pathname);
  if (providerAccountRoute?.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:read',
    ]);
    if (!auth) return true;
    try {
      const providerAccount = await services().providerAccounts.get({
        appId: auth.appId as AppId,
        providerAccountId:
          providerAccountRoute.providerAccountId as ProviderAccountId,
      });
      sendJson(res, 200, providerAccountToResponse(providerAccount));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (providerAccountRoute?.action === 'get' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    const parsed = UpdateProviderAccountRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid provider account patch');
      return true;
    }
    try {
      const providerAccount = await services().providerAccounts.update({
        appId: auth.appId as AppId,
        providerAccountId:
          providerAccountRoute.providerAccountId as ProviderAccountId,
        patch: {
          label: parsed.data.label,
          status: parsed.data.status,
          enabled: parsed.data.enabled,
          config: parsed.data.config,
          externalInstallationRef:
            parsed.data.externalRef === null
              ? null
              : externalRefFromContract(
                  parsed.data.externalRef,
                  'provider_account',
                ),
          runtimeSecretRefs: parsed.data.runtimeSecretRefs,
        },
      });
      if (providerAccount.status === 'disabled') {
        await removeProviderAccountRoutesFromRuntime(ctx, providerAccount.id);
      } else {
        await projectProviderAccountRoutesToRuntime(ctx, providerAccount.id);
      }
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, providerAccountToResponse(providerAccount));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (providerAccountRoute?.action === 'get' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    try {
      const providerAccount = await services().providerAccounts.disable({
        appId: auth.appId as AppId,
        providerAccountId:
          providerAccountRoute.providerAccountId as ProviderAccountId,
      });
      await removeProviderAccountRoutesFromRuntime(ctx, providerAccount.id);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, {
        deleted: true,
        providerAccount: providerAccountToResponse(providerAccount),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (providerAccountRoute?.action === 'discover' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    const parsed = DiscoverProviderAccountRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid discovery request');
      return true;
    }
    try {
      const conversations = await services(
        auth.appId as AppId,
      ).discovery.execute({
        appId: auth.appId as AppId,
        providerAccountId:
          providerAccountRoute.providerAccountId as ProviderAccountId,
        query: parsed.data.query,
        limit: parsed.data.limit,
        includeArchived: parsed.data.includeArchived,
        providerMetadata: parsed.data.providerMetadata,
      });
      sendJson(res, 200, {
        conversations: conversations.map(conversationToResponse),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (pathname === '/v1/conversations' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:read',
    ]);
    if (!auth) return true;
    const conversations = await services().conversations.list({
      appId: auth.appId as AppId,
      providerAccountId:
        (url.searchParams.get(
          'providerAccountId',
        ) as ProviderAccountId | null) ?? undefined,
    });
    sendJson(res, 200, {
      conversations: conversations.map(conversationToResponse),
    });
    return true;
  }

  const conversationRoute = parseConversationRoute(pathname);
  if (conversationRoute?.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:read',
    ]);
    if (!auth) return true;
    try {
      const conversation = await services().conversations.get({
        appId: auth.appId as AppId,
        conversationId: conversationRoute.conversationId as ConversationId,
      });
      sendJson(res, 200, conversationToResponse(conversation));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const approversMatch = /^\/v1\/conversations\/([^/]+)\/approvers$/.exec(
    pathname,
  );
  if (approversMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:read',
    ]);
    if (!auth) return true;
    try {
      const summary = await new ConversationAdministrationService({
        providerAccounts: getRuntimeStorage().repositories.providerAccounts,
        conversations: getRuntimeStorage().repositories.conversations,
      }).getAdminSummary({
        appId: auth.appId as AppId,
        conversationId: decodeURIComponent(
          approversMatch[1]!,
        ) as ConversationId,
      });
      sendJson(res, 200, { approvers: summary.controlAllowlist });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (approversMatch && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:admin',
    ]);
    if (!auth) return true;
    const parsed = ConversationApproverPutRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid conversation approver request',
      );
      return true;
    }
    try {
      const result = await new ConversationAdministrationService(
        {
          providerAccounts: getRuntimeStorage().repositories.providerAccounts,
          conversations: getRuntimeStorage().repositories.conversations,
        },
        new RuntimeSecretConversationMembershipValidator(
          createRepositoryRuntimeSecretProvider({
            appId: auth.appId as AppId,
            repository: getRuntimeStorage().repositories.capabilitySecrets,
          }),
        ),
      ).replaceControlAllowlist({
        appId: auth.appId as AppId,
        conversationId: decodeURIComponent(
          approversMatch[1]!,
        ) as ConversationId,
        userIds: parsed.data.userIds,
        updatedAt: nowIso(),
      });
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, { approvers: result });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (conversationRoute?.action === 'threads' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:read',
    ]);
    if (!auth) return true;
    try {
      const threads = await services().conversations.listThreads({
        appId: auth.appId as AppId,
        conversationId: conversationRoute.conversationId as ConversationId,
      });
      sendJson(res, 200, { threads: threads.map(threadToResponse) });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (conversationRoute?.action === 'messages' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['messages:read']);
    if (!auth) return true;
    try {
      const messages = await services().conversations.listMessages({
        appId: auth.appId as AppId,
        conversationId: conversationRoute.conversationId as ConversationId,
        threadId:
          (url.searchParams.get('threadId') as ConversationThreadId | null) ??
          undefined,
        after: url.searchParams.get('after') ?? undefined,
        limit: parseLimit(url.searchParams.get('limit')),
      });
      sendJson(res, 200, { messages: messages.map(messageToResponse) });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const installRoute = parseConversationInstallRoute(pathname);
  if (installRoute?.action === 'list' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:read',
    ]);
    if (!auth) return true;
    try {
      const conversationInstalls = await services().conversationInstalls.list({
        appId: auth.appId as AppId,
        agentId: installRoute.agentId as AgentId,
      });
      sendJson(res, 200, {
        conversationInstalls: conversationInstalls.map(
          conversationInstallToResponse,
        ),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (installRoute?.action === 'install' && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'agents:admin',
      'conversations:admin',
    ]);
    if (!auth) return true;
    const patch = parseConversationInstallPatch(
      auth.appId as AppId,
      installRoute.conversationId as ConversationId,
      await readJson(req),
    );
    if (!patch) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid conversation install request',
      );
      return true;
    }
    try {
      const install = await services().conversationInstalls.enable({
        appId: auth.appId as AppId,
        agentId: installRoute.agentId as AgentId,
        conversationId: installRoute.conversationId as ConversationId,
        patch,
      });
      await projectConversationInstallToRuntime(ctx, install);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, conversationInstallToResponse(install));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (installRoute?.action === 'install' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'agents:admin',
      'conversations:admin',
    ]);
    if (!auth) return true;
    const patch = parseConversationInstallPatch(
      auth.appId as AppId,
      installRoute.conversationId as ConversationId,
      await readJson(req),
    );
    if (!patch) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid conversation install patch',
      );
      return true;
    }
    try {
      const install = await services().conversationInstalls.update({
        appId: auth.appId as AppId,
        agentId: installRoute.agentId as AgentId,
        conversationId: installRoute.conversationId as ConversationId,
        patch,
      });
      await projectConversationInstallToRuntime(ctx, install);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, conversationInstallToResponse(install));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (installRoute?.action === 'install' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'agents:admin',
      'conversations:admin',
    ]);
    if (!auth) return true;
    try {
      const install = await services().conversationInstalls.disable({
        appId: auth.appId as AppId,
        agentId: installRoute.agentId as AgentId,
        conversationId: installRoute.conversationId as ConversationId,
        threadId:
          (url.searchParams.get('threadId') as ConversationThreadId | null) ??
          undefined,
      });
      await removeConversationInstallFromRuntime(ctx, install);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, {
        disabled: true,
        conversationInstall: conversationInstallToResponse(install),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  return false;
}

function parseTeamsThreadReplyRequest(body: unknown): {
  conversationId: string;
  replyToId: string;
  text: string;
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const conversationId = readNonEmptyString(record.conversationId);
  const replyToId = readNonEmptyString(record.replyToId);
  const text = readNonEmptyString(record.text);
  if (!conversationId || !replyToId || !text) return null;
  return { conversationId, replyToId, text };
}

function teamsThreadConversationId(
  conversationId: string,
  replyToId: string,
): string {
  const canonical = canonicalTeamsConversationId(conversationId);
  return canonical.includes(';messageid=')
    ? canonical
    : `${canonical};messageid=${replyToId}`;
}

function canonicalTeamsConversationId(conversationId: string): string {
  return conversationId.startsWith('teams:')
    ? conversationId.slice('teams:'.length).trim()
    : conversationId.trim();
}

function normalizeTeamsJid(conversationId: string): string {
  return conversationId.startsWith('teams:')
    ? conversationId
    : `teams:${conversationId}`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

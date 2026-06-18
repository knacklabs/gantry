import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AgentConversationBindingRequestSchema,
  ConversationApproverPutRequestSchema,
  CreateProviderConnectionRequestSchema,
  DiscoverProviderConnectionRequestSchema,
  UpdateProviderConnectionRequestSchema,
} from '@gantry/contracts';

import { EnvRuntimeSecretProvider } from '../../../adapters/credentials/env-runtime-secret-provider.js';
import { RuntimeSecretConversationMembershipValidator } from '../../../channels/conversation-membership-validation.js';
import {
  BuiltInControlChannelProviderCatalog,
  RuntimeSecretConversationDiscovery,
} from '../../../channels/control-provider-catalog.js';
import { getProvider } from '../../../channels/provider-registry.js';
import { ConversationAdministrationService } from '../../../application/provider-conversations/conversation-administration-service.js';
import {
  AgentConversationBindingControlService,
  ProviderConnectionControlService,
  DiscoverProviderConversationsService,
} from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import { ListProvidersUseCase } from '../../../application/provider-conversations/list-providers-use-case.js';
import { ConversationControlService } from '../../../application/conversations/conversation-control-use-cases.js';
import type { Agent, AgentId } from '../../../domain/agent/agent.js';
import { folderForAgentId } from '../../../domain/agent/agent-folder-id.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  AgentConversationBinding,
  ProviderConnectionId,
  ProviderId,
} from '../../../domain/provider/provider.js';
import type {
  Conversation,
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
  parseAgentBindingRoute,
  parseProviderConnectionRoute,
  parseConversationRoute,
} from '../route-parser.js';
import {
  bindingPatchFromParsed,
  bindingToResponse,
  conversationToResponse,
  externalRefFromContract,
  providerConnectionToResponse,
  messageToResponse,
  parseLimit,
  providerToResponse,
  threadToResponse,
} from './provider-conversation-mappers.js';

interface RuntimeConversationRouteState {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean;
  conversationKind: 'dm' | 'channel';
}

const providers = new BuiltInControlChannelProviderCatalog();

function services() {
  const repositories = getRuntimeStorage().repositories;
  const ids = { generate: randomUUID };
  const clock = { now: nowIso };
  return {
    providerConnections: new ProviderConnectionControlService({
      providerConnections: repositories.providerConnections,
      providers,
      ids,
      clock,
    }),
    discovery: new DiscoverProviderConversationsService({
      providerConnections: repositories.providerConnections,
      conversations: repositories.conversations,
      discovery: new RuntimeSecretConversationDiscovery(
        new EnvRuntimeSecretProvider(),
      ),
      ids,
      clock,
    }),
    conversations: new ConversationControlService({
      conversations: repositories.conversations,
      messages: repositories.messages,
    }),
    bindings: new AgentConversationBindingControlService({
      agents: repositories.agents,
      providerConnections: repositories.providerConnections,
      conversations: repositories.conversations,
      ids,
      clock,
    }),
  };
}

function parseBindingPatch(
  appId: AppId,
  conversationId: ConversationId,
  raw: unknown,
) {
  const parsed = AgentConversationBindingRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return bindingPatchFromParsed(appId, conversationId, parsed.data);
}

export async function handleProviderConversationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
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

  if (pathname === '/v1/provider-connections' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:read',
    ]);
    if (!auth) return true;
    const result = await services().providerConnections.list(
      auth.appId as AppId,
    );
    sendJson(res, 200, {
      providerConnections: result.map(providerConnectionToResponse),
    });
    return true;
  }

  if (pathname === '/v1/provider-connections' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    const parsed = CreateProviderConnectionRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid provider connection');
      return true;
    }
    if (parsed.data.appId !== auth.appId) {
      sendError(
        res,
        403,
        'FORBIDDEN',
        'API key cannot create provider connections for this app',
      );
      return true;
    }
    try {
      const providerConnection = await services().providerConnections.create({
        appId: auth.appId as AppId,
        providerId: parsed.data.providerId as ProviderId,
        label: parsed.data.label,
        config: parsed.data.config,
        externalInstallationRef: externalRefFromContract(
          parsed.data.externalRef,
          'provider_connection',
        ),
        runtimeSecretRefs: parsed.data.runtimeSecretRefs,
        enabled: parsed.data.enabled,
      });
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 201, providerConnectionToResponse(providerConnection));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const providerConnectionRoute = parseProviderConnectionRoute(pathname);
  if (providerConnectionRoute?.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:read',
    ]);
    if (!auth) return true;
    try {
      const providerConnection = await services().providerConnections.get({
        appId: auth.appId as AppId,
        providerConnectionId:
          providerConnectionRoute.providerConnectionId as ProviderConnectionId,
      });
      sendJson(res, 200, providerConnectionToResponse(providerConnection));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (providerConnectionRoute?.action === 'get' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    const parsed = UpdateProviderConnectionRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid provider connection patch',
      );
      return true;
    }
    try {
      const providerConnection = await services().providerConnections.update({
        appId: auth.appId as AppId,
        providerConnectionId:
          providerConnectionRoute.providerConnectionId as ProviderConnectionId,
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
                  'provider_connection',
                ),
          runtimeSecretRefs: parsed.data.runtimeSecretRefs,
        },
      });
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, providerConnectionToResponse(providerConnection));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (providerConnectionRoute?.action === 'get' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    try {
      const providerConnection = await services().providerConnections.disable({
        appId: auth.appId as AppId,
        providerConnectionId:
          providerConnectionRoute.providerConnectionId as ProviderConnectionId,
      });
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, {
        deleted: true,
        providerConnection: providerConnectionToResponse(providerConnection),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (providerConnectionRoute?.action === 'discover' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'providers:admin',
    ]);
    if (!auth) return true;
    const parsed = DiscoverProviderConnectionRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid discovery request');
      return true;
    }
    try {
      const conversations = await services().discovery.execute({
        appId: auth.appId as AppId,
        providerConnectionId:
          providerConnectionRoute.providerConnectionId as ProviderConnectionId,
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
      providerConnectionId:
        (url.searchParams.get(
          'providerConnectionId',
        ) as ProviderConnectionId | null) ?? undefined,
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
        providerConnections:
          getRuntimeStorage().repositories.providerConnections,
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
          providerConnections:
            getRuntimeStorage().repositories.providerConnections,
          conversations: getRuntimeStorage().repositories.conversations,
        },
        new RuntimeSecretConversationMembershipValidator(
          new EnvRuntimeSecretProvider(),
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

  const bindingRoute = parseAgentBindingRoute(pathname);
  if (bindingRoute?.action === 'list' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'conversations:read',
    ]);
    if (!auth) return true;
    try {
      const bindings = await services().bindings.list({
        appId: auth.appId as AppId,
        agentId: bindingRoute.agentId as AgentId,
      });
      sendJson(res, 200, { bindings: bindings.map(bindingToResponse) });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (bindingRoute?.action === 'binding' && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'agents:admin',
      'conversations:admin',
    ]);
    if (!auth) return true;
    const patch = parseBindingPatch(
      auth.appId as AppId,
      bindingRoute.conversationId as ConversationId,
      await readJson(req),
    );
    if (!patch) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid conversation binding request',
      );
      return true;
    }
    try {
      const binding = await services().bindings.enable({
        appId: auth.appId as AppId,
        agentId: bindingRoute.agentId as AgentId,
        conversationId: bindingRoute.conversationId as ConversationId,
        patch,
      });
      await projectBindingToRuntime(ctx, binding);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, bindingToResponse(binding));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (bindingRoute?.action === 'binding' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'agents:admin',
      'conversations:admin',
    ]);
    if (!auth) return true;
    const patch = parseBindingPatch(
      auth.appId as AppId,
      bindingRoute.conversationId as ConversationId,
      await readJson(req),
    );
    if (!patch) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid conversation binding patch',
      );
      return true;
    }
    try {
      const binding = await services().bindings.update({
        appId: auth.appId as AppId,
        agentId: bindingRoute.agentId as AgentId,
        conversationId: bindingRoute.conversationId as ConversationId,
        patch,
      });
      await projectBindingToRuntime(ctx, binding);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, bindingToResponse(binding));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (bindingRoute?.action === 'binding' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'agents:admin',
      'conversations:admin',
    ]);
    if (!auth) return true;
    try {
      const binding = await services().bindings.disable({
        appId: auth.appId as AppId,
        agentId: bindingRoute.agentId as AgentId,
        conversationId: bindingRoute.conversationId as ConversationId,
        threadId:
          (url.searchParams.get('threadId') as ConversationThreadId | null) ??
          undefined,
      });
      await removeBindingFromRuntime(ctx, binding);
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, {
        disabled: true,
        binding: bindingToResponse(binding),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  return false;
}

async function projectBindingToRuntime(
  ctx: ControlRouteContext,
  binding: AgentConversationBinding,
): Promise<void> {
  if (binding.status !== 'active') {
    await removeBindingFromRuntime(ctx, binding);
    return;
  }
  if (binding.threadId) return;
  const projectRoute = (ctx.app as { projectConversationRoute?: unknown })
    .projectConversationRoute;
  if (typeof projectRoute !== 'function') return;

  const repositories = getRuntimeStorage().repositories;
  const [agent, conversation] = await Promise.all([
    repositories.agents.getAgent(binding.agentId),
    repositories.conversations.getConversation(binding.conversationId),
  ]);
  if (!agent || !conversation) return;
  const providerConnection =
    await repositories.providerConnections.getProviderConnection(
      binding.providerConnectionId,
    );
  if (!providerConnection) return;

  const externalConversationId = conversation.externalRef?.value?.trim();
  if (!externalConversationId) return;
  const jid = jidForConversation(
    String(providerConnection.providerId),
    externalConversationId,
  );
  await projectRoute.call(
    ctx.app,
    jid,
    routeStateForBinding({ agent, binding, conversation }),
  );
}

async function removeBindingFromRuntime(
  ctx: ControlRouteContext,
  binding: AgentConversationBinding,
): Promise<void> {
  if (binding.threadId) return;
  const removeRoute = (ctx.app as { unregisterConversationRoute?: unknown })
    .unregisterConversationRoute;
  if (typeof removeRoute !== 'function') return;

  const repositories = getRuntimeStorage().repositories;
  const conversation = await repositories.conversations.getConversation(
    binding.conversationId,
  );
  if (!conversation) return;
  const providerConnection =
    await repositories.providerConnections.getProviderConnection(
      binding.providerConnectionId,
    );
  if (!providerConnection) return;

  const externalConversationId = conversation.externalRef?.value?.trim();
  if (!externalConversationId) return;
  const jid = jidForConversation(
    String(providerConnection.providerId),
    externalConversationId,
  );
  await removeRoute.call(ctx.app, jid);
}

function routeStateForBinding(input: {
  agent: Agent;
  binding: AgentConversationBinding;
  conversation: Conversation;
}): RuntimeConversationRouteState {
  const folder = folderForAgentId(input.agent.id) ?? String(input.agent.id);
  return {
    name: input.binding.displayName || input.agent.name,
    folder,
    trigger:
      input.binding.triggerPattern?.trim() ||
      `@${(input.agent.name || folder).trim() || 'agent'}`,
    added_at: input.binding.createdAt,
    requiresTrigger: input.binding.requiresTrigger,
    conversationKind: input.conversation.kind === 'direct' ? 'dm' : 'channel',
  };
}

function jidForConversation(providerId: string, externalId: string): string {
  const provider = getProvider(providerId);
  const trimmed = externalId.trim();
  if (!provider?.jidPrefix || trimmed.startsWith(provider.jidPrefix)) {
    return trimmed;
  }
  return `${provider.jidPrefix}${trimmed}`;
}

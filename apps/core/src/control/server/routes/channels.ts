import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AgentChannelBindingRequestSchema,
  CreateChannelInstallationRequestSchema,
  DiscoverChannelInstallationRequestSchema,
  UpdateChannelInstallationRequestSchema,
} from '@myclaw/contracts';

import { EnvRuntimeSecretProvider } from '../../../adapters/credentials/env-runtime-secret-provider.js';
import {
  BuiltInControlChannelProviderCatalog,
  RuntimeSecretConversationDiscovery,
} from '../../../channels/control-provider-catalog.js';
import {
  AgentChannelBindingControlService,
  ChannelInstallationControlService,
  DiscoverChannelConversationsService,
} from '../../../application/channels/channel-control-use-cases.js';
import { ListChannelProvidersUseCase } from '../../../application/channels/list-channel-providers-use-case.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { ConversationControlService } from '../../../application/conversations/conversation-control-use-cases.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  ChannelInstallationId,
  ChannelProviderId,
} from '../../../domain/channel/channel.js';
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
import { readJson, sendError, sendJson } from '../http.js';
import {
  parseAgentBindingRoute,
  parseChannelInstallationRoute,
  parseConversationRoute,
} from '../route-parser.js';
import {
  bindingPatchFromParsed,
  bindingToResponse,
  conversationToResponse,
  externalRefFromContract,
  installationToResponse,
  messageToResponse,
  parseLimit,
  providerToResponse,
  threadToResponse,
} from './channel-mappers.js';
import { handleChannelAdminFacadeRoutes } from './channel-admin-facade.js';

const providers = new BuiltInControlChannelProviderCatalog();

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  switch (error.code) {
    case 'NOT_FOUND':
      sendError(res, 404, 'NOT_FOUND', error.message);
      return true;
    case 'FORBIDDEN':
      sendError(res, 403, 'FORBIDDEN', error.message);
      return true;
    case 'INVALID_REQUEST':
      sendError(res, 400, 'INVALID_REQUEST', error.message);
      return true;
    case 'CONFLICT':
      sendError(res, 409, 'CONFLICT', error.message);
      return true;
    case 'UNAVAILABLE':
      sendError(res, 503, 'UNAVAILABLE', error.message);
      return true;
    case 'NOT_IMPLEMENTED':
      sendError(res, 501, 'NOT_IMPLEMENTED', error.message);
      return true;
    default:
      return false;
  }
}

function services() {
  const repositories = getRuntimeStorage().repositories;
  const ids = { generate: randomUUID };
  const clock = { now: nowIso };
  return {
    installations: new ChannelInstallationControlService({
      installations: repositories.channelInstallations,
      providers,
      ids,
      clock,
    }),
    discovery: new DiscoverChannelConversationsService({
      installations: repositories.channelInstallations,
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
    bindings: new AgentChannelBindingControlService({
      agents: repositories.agents,
      installations: repositories.channelInstallations,
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
  const parsed = AgentChannelBindingRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return bindingPatchFromParsed(appId, conversationId, parsed.data);
}

export async function handleChannelControlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (await handleChannelAdminFacadeRoutes(req, res, ctx, url, pathname)) {
    return true;
  }

  if (pathname === '/v1/channel-providers' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
    if (!auth) return true;
    const result = await new ListChannelProvidersUseCase(providers).execute();
    sendJson(res, 200, {
      providers: result.providers.map(providerToResponse),
    });
    return true;
  }

  if (pathname === '/v1/channel-installations' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
    if (!auth) return true;
    const result = await services().installations.list(auth.appId as AppId);
    sendJson(res, 200, {
      installations: result.map(installationToResponse),
    });
    return true;
  }

  if (pathname === '/v1/channel-installations' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    const parsed = CreateChannelInstallationRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel installation');
      return true;
    }
    if (parsed.data.appId !== auth.appId) {
      sendError(
        res,
        403,
        'FORBIDDEN',
        'API key cannot create channel installations for this app',
      );
      return true;
    }
    try {
      const installation = await services().installations.create({
        appId: auth.appId as AppId,
        providerId: parsed.data.providerId as ChannelProviderId,
        label: parsed.data.label,
        config: parsed.data.config,
        externalInstallationRef: externalRefFromContract(
          parsed.data.externalRef,
          'channel_installation',
        ),
        runtimeSecretRefs: parsed.data.runtimeSecretRefs,
        enabled: parsed.data.enabled,
      });
      sendJson(res, 201, installationToResponse(installation));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const installationRoute = parseChannelInstallationRoute(pathname);
  if (installationRoute?.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
    if (!auth) return true;
    try {
      const installation = await services().installations.get({
        appId: auth.appId as AppId,
        installationId:
          installationRoute.installationId as ChannelInstallationId,
      });
      sendJson(res, 200, installationToResponse(installation));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (installationRoute?.action === 'get' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    const parsed = UpdateChannelInstallationRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid channel installation patch',
      );
      return true;
    }
    try {
      const installation = await services().installations.update({
        appId: auth.appId as AppId,
        installationId:
          installationRoute.installationId as ChannelInstallationId,
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
                  'channel_installation',
                ),
          runtimeSecretRefs: parsed.data.runtimeSecretRefs,
        },
      });
      sendJson(res, 200, installationToResponse(installation));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (installationRoute?.action === 'get' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    try {
      const installation = await services().installations.disable({
        appId: auth.appId as AppId,
        installationId:
          installationRoute.installationId as ChannelInstallationId,
      });
      sendJson(res, 200, {
        deleted: true,
        installation: installationToResponse(installation),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (installationRoute?.action === 'discover' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    const parsed = DiscoverChannelInstallationRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid discovery request');
      return true;
    }
    try {
      const conversations = await services().discovery.execute({
        appId: auth.appId as AppId,
        installationId:
          installationRoute.installationId as ChannelInstallationId,
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
      channelInstallationId:
        (url.searchParams.get(
          'channelInstallationId',
        ) as ChannelInstallationId | null) ?? undefined,
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
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
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
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const patch = parseBindingPatch(
      auth.appId as AppId,
      bindingRoute.conversationId as ConversationId,
      await readJson(req),
    );
    if (!patch) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel binding request');
      return true;
    }
    try {
      const binding = await services().bindings.enable({
        appId: auth.appId as AppId,
        agentId: bindingRoute.agentId as AgentId,
        conversationId: bindingRoute.conversationId as ConversationId,
        patch,
      });
      sendJson(res, 200, bindingToResponse(binding));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (bindingRoute?.action === 'binding' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const patch = parseBindingPatch(
      auth.appId as AppId,
      bindingRoute.conversationId as ConversationId,
      await readJson(req),
    );
    if (!patch) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel binding patch');
      return true;
    }
    try {
      const binding = await services().bindings.update({
        appId: auth.appId as AppId,
        agentId: bindingRoute.agentId as AgentId,
        conversationId: bindingRoute.conversationId as ConversationId,
        patch,
      });
      sendJson(res, 200, bindingToResponse(binding));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (bindingRoute?.action === 'binding' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
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

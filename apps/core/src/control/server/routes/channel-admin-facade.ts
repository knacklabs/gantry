import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  BindChannelAgentsRequestSchema,
  CreateChannelRequestSchema,
  CreateChannelSessionRequestSchema,
  UpdateChannelControlAllowlistRequestSchema,
  UpdateChannelRequestSchema,
} from '@myclaw/contracts';

import { AgentChannelBindingControlService } from '../../../application/channels/channel-control-use-cases.js';
import { ChannelAdministrationService } from '../../../application/channels/channel-administration-service.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { ConversationControlService } from '../../../application/conversations/conversation-control-use-cases.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { EnvRuntimeSecretProvider } from '../../../adapters/credentials/env-runtime-secret-provider.js';
import { RuntimeSecretChannelMembershipValidator } from '../../../channels/channel-membership-validation.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ChannelInstallationId } from '../../../domain/channel/channel.js';
import type {
  ConversationId,
  ConversationThread,
  ConversationThreadId,
} from '../../../domain/conversation/conversation.js';
import type { ExternalRef } from '../../../shared/ids/branded-id.js';
import { nowIso } from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  bindingToResponse,
  conversationToResponse,
  threadToResponse,
} from './channel-mappers.js';

export async function handleChannelAdminFacadeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/channels' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
    if (!auth) return true;
    const conversations = await services().conversations.list({
      appId: auth.appId as AppId,
      channelInstallationId:
        (url.searchParams.get(
          'channelInstallationId',
        ) as ChannelInstallationId | null) ?? undefined,
    });
    sendJson(res, 200, { channels: conversations.map(conversationToResponse) });
    return true;
  }

  if (pathname === '/v1/channels' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    const parsed = CreateChannelRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel');
      return true;
    }
    const channelInstallationId = parsed.data
      .channelInstallationId as ChannelInstallationId;
    const title = (parsed.data.title ?? parsed.data.label ?? '').trim();
    const repositories = getRuntimeStorage().repositories;
    const installation =
      await repositories.channelInstallations.getChannelInstallation(
        channelInstallationId,
      );
    if (!installation || installation.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Channel installation not found');
      return true;
    }
    const now = nowIso();
    const conversation = {
      id: `channel:${randomUUID()}` as ConversationId,
      appId: auth.appId as AppId,
      channelInstallationId,
      externalRef: {
        kind: 'conversation',
        value: parsed.data.externalId,
      } as ExternalRef<'conversation'>,
      kind: parsed.data.kind ?? 'channel',
      title,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as const;
    await repositories.conversations.saveConversation(conversation);
    sendJson(res, 201, conversationToResponse(conversation));
    return true;
  }

  const channelRoute = pathname.match(
    /^\/v1\/channels\/([^/]+)(?:\/(admin|agents|sessions|control-allowlist))?$/,
  );
  if (!channelRoute) return false;
  const channelId = decodeURIComponent(channelRoute[1]) as ConversationId;
  const action = channelRoute[2];

  if (action === undefined && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
    if (!auth) return true;
    try {
      const channel = await services().conversations.get({
        appId: auth.appId as AppId,
        conversationId: channelId,
      });
      sendJson(res, 200, conversationToResponse(channel));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (action === undefined && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    const repositories = getRuntimeStorage().repositories;
    const channel = await repositories.conversations.getConversation(channelId);
    if (!channel || channel.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Channel not found');
      return true;
    }
    const parsed = UpdateChannelRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel update');
      return true;
    }
    const updated = {
      ...channel,
      title: parsed.data.title ?? channel.title,
      status: parsed.data.status ?? channel.status,
      updatedAt: nowIso(),
    };
    await repositories.conversations.saveConversation(updated);
    sendJson(res, 200, conversationToResponse(updated));
    return true;
  }

  if (action === 'admin' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['channels:read']);
    if (!auth) return true;
    const repositories = getRuntimeStorage().repositories;
    const channel = await repositories.conversations.getConversation(channelId);
    if (!channel || channel.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Channel not found');
      return true;
    }
    const [bindings, sessions, adminSummary] = await Promise.all([
      repositories.channelInstallations.listAgentChannelBindingsByConversation({
        appId: auth.appId as AppId,
        conversationId: channel.id,
      }),
      repositories.conversations.listThreads(channel.id),
      administrationService().getAdminSummary({
        appId: auth.appId as AppId,
        conversationId: channel.id,
      }),
    ]);
    sendJson(res, 200, {
      channel: conversationToResponse(channel),
      agents: bindings.map(bindingToResponse),
      sessions: sessions.map(threadToResponse),
      controlAllowlist: adminSummary.controlAllowlist,
    });
    return true;
  }

  if (action === 'agents' && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = BindChannelAgentsRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel agent bindings');
      return true;
    }
    const agentIds = parsed.data.agentIds;
    const defaultAgentId = parsed.data.defaultAgentId ?? agentIds[0];
    try {
      const channel = await services().conversations.get({
        appId: auth.appId as AppId,
        conversationId: channelId,
      });
      const repositories = getRuntimeStorage().repositories;
      const existing =
        await repositories.channelInstallations.listAgentChannelBindingsByConversation(
          {
            appId: auth.appId as AppId,
            conversationId: channel.id,
          },
        );
      const selected = new Set(agentIds);
      await Promise.all(
        existing
          .filter(
            (binding) =>
              binding.status === 'active' && !selected.has(binding.agentId),
          )
          .map((binding) =>
            services().bindings.disable({
              appId: auth.appId as AppId,
              agentId: binding.agentId,
              conversationId: channel.id,
              threadId: binding.threadId,
            }),
          ),
      );
      const bindings = await Promise.all(
        agentIds.map((agentId) => {
          const isDefault = agentId === defaultAgentId;
          return services().bindings.enable({
            appId: auth.appId as AppId,
            agentId: agentId as AgentId,
            conversationId: channel.id,
            patch: {
              triggerMode: isDefault ? 'always' : 'mention',
              requiresTrigger: !isDefault,
              displayName: channel.title ?? channel.id,
              status: 'active',
            },
          });
        }),
      );
      sendJson(res, 200, { bindings: bindings.map(bindingToResponse) });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (action === 'sessions' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'sessions:write',
    ]);
    if (!auth) return true;
    const parsed = CreateChannelSessionRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid channel session');
      return true;
    }
    const repositories = getRuntimeStorage().repositories;
    const channel = await repositories.conversations.getConversation(channelId);
    if (!channel || channel.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Channel not found');
      return true;
    }
    const now = nowIso();
    const thread: ConversationThread = {
      id: `session:${randomUUID()}` as ConversationThreadId,
      appId: auth.appId as AppId,
      conversationId: channel.id,
      externalRef: parsed.data.externalThreadId
        ? ({
            kind: 'conversation_thread',
            value: parsed.data.externalThreadId,
          } as ExternalRef<'conversation_thread'>)
        : undefined,
      title: parsed.data.title,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await repositories.conversations.saveThread(thread);
    sendJson(res, 201, threadToResponse(thread));
    return true;
  }

  if (action === 'control-allowlist' && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'channels:admin',
    ]);
    if (!auth) return true;
    const parsed = UpdateChannelControlAllowlistRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid control allowlist');
      return true;
    }
    try {
      const controlAllowlist =
        await administrationService().replaceControlAllowlist({
          appId: auth.appId as AppId,
          conversationId: channelId,
          userIds: parsed.data.userIds,
          updatedAt: nowIso(),
        });
      sendJson(res, 200, { controlAllowlist });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  return false;
}

function administrationService(): ChannelAdministrationService {
  const repositories = getRuntimeStorage().repositories;
  return new ChannelAdministrationService(
    {
      channelInstallations: repositories.channelInstallations,
      conversations: repositories.conversations,
    },
    new RuntimeSecretChannelMembershipValidator(new EnvRuntimeSecretProvider()),
  );
}

function services() {
  const repositories = getRuntimeStorage().repositories;
  const ids = { generate: randomUUID };
  const clock = { now: nowIso };
  return {
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

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  const statuses: Record<string, number> = {
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    INVALID_REQUEST: 400,
    INVALID_CONTROL_ALLOWLIST: 400,
    CONFLICT: 409,
    UNAVAILABLE: 503,
    NOT_IMPLEMENTED: 501,
  };
  sendError(res, statuses[error.code] ?? 400, error.code, error.message);
  return true;
}

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '@myclaw/contracts';

import { ApplicationError } from '../../../application/common/application-error.js';
import { AgentCapabilityAdministrationService } from '../../../application/agents/agent-capability-administration-service.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { Agent, AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { AgentConversationBinding } from '../../../domain/provider/provider.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

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
    default:
      return false;
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/agents' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agents = await getRuntimeStorage().repositories.agents.listAgents(
      auth.appId as AppId,
    );
    sendJson(res, 200, { agents: agents.map(agentToResponse) });
    return true;
  }

  if (pathname === '/v1/agents' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = CreateAgentRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent');
      return true;
    }
    if (parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot create agent for app');
      return true;
    }
    const now = new Date().toISOString();
    const agent: Agent = {
      id: `agent:${randomUUID()}` as AgentId,
      appId: auth.appId as AppId,
      name: parsed.data.name.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await getRuntimeStorage().repositories.agents.saveAgent(agent);
    await ctx.syncSettingsFromProjection(auth.appId as AppId);
    sendJson(res, 201, agentToResponse(agent));
    return true;
  }

  const agentAdminMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/admin$/);
  if (agentAdminMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agentId = decodeURIComponent(agentAdminMatch[1]) as AgentId;
    const agent =
      await getRuntimeStorage().repositories.agents.getAgent(agentId);
    if (!agent || agent.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return true;
    }
    try {
      const boundConversations = await agentBoundConversations({
        appId: auth.appId as AppId,
        agentId,
      });
      const repositories = getRuntimeStorage().repositories;
      const capabilities =
        repositories.tools && repositories.skills && repositories.mcpServers
          ? await new AgentCapabilityAdministrationService({
              agents: repositories.agents,
              tools: repositories.tools,
              skills: repositories.skills,
              mcpServers: repositories.mcpServers,
            }).getCapabilities({
              appId: auth.appId as AppId,
              agentId,
            })
          : undefined;
      sendJson(res, 200, {
        agent: agentToResponse(agent),
        capabilities,
        boundConversations,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (agentMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agent = await getRuntimeStorage().repositories.agents.getAgent(
      decodeURIComponent(agentMatch[1]) as AgentId,
    );
    if (!agent || agent.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return true;
    }
    sendJson(res, 200, agentToResponse(agent));
    return true;
  }

  const patchMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = UpdateAgentRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent update');
      return true;
    }
    const repository = getRuntimeStorage().repositories.agents;
    const agent = await repository.getAgent(
      decodeURIComponent(patchMatch[1]) as AgentId,
    );
    if (!agent || agent.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return true;
    }
    const updated: Agent = {
      ...agent,
      name: parsed.data.name?.trim() ?? agent.name,
      status: parsed.data.status ?? agent.status,
      updatedAt: new Date().toISOString(),
    };
    await repository.saveAgent(updated);
    await ctx.syncSettingsFromProjection(auth.appId as AppId);
    sendJson(res, 200, agentToResponse(updated));
    return true;
  }

  return false;
}

function agentToResponse(agent: Agent) {
  return {
    id: agent.id,
    appId: agent.appId,
    name: agent.name,
    status: agent.status,
    currentConfigVersionId: agent.currentConfigVersionId,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

async function agentBoundConversations(input: {
  appId: AppId;
  agentId: AgentId;
}): Promise<
  Array<{
    conversationId: string;
    provider: string;
    kind: string;
    displayName?: string;
    approverUserIds: string[];
    requiresTrigger: boolean;
  }>
> {
  const repositories = getRuntimeStorage().repositories;
  const bindings =
    await repositories.providerConnections.listAgentConversationBindings(
      input.appId,
      input.agentId,
    );
  const activeBindings = bindings
    .filter((binding) => binding.status === 'active')
    .sort((a, b) =>
      String(a.conversationId).localeCompare(String(b.conversationId)),
    );
  const summaries = await Promise.all(
    activeBindings.map(async (binding) =>
      agentBoundConversation(input.appId, binding),
    ),
  );
  return summaries.filter(
    (summary): summary is NonNullable<typeof summary> => summary !== null,
  );
}

async function agentBoundConversation(
  appId: AppId,
  binding: AgentConversationBinding,
): Promise<{
  conversationId: string;
  provider: string;
  kind: string;
  displayName?: string;
  approverUserIds: string[];
  requiresTrigger: boolean;
} | null> {
  const repositories = getRuntimeStorage().repositories;
  const conversation = await repositories.conversations.getConversation(
    binding.conversationId,
  );
  if (!conversation || conversation.appId !== appId) return null;
  const providerConnection =
    await repositories.providerConnections.getProviderConnection(
      conversation.providerConnectionId,
    );
  if (!providerConnection || providerConnection.appId !== appId) return null;
  const approvers = await repositories.conversations.listConversationApprovers(
    conversation.id,
  );
  return {
    conversationId: conversation.id,
    provider: providerConnection.providerId,
    kind: conversation.kind,
    ...(conversation.title ? { displayName: conversation.title } : {}),
    approverUserIds: approvers.map((approver) => approver.externalUserId),
    requiresTrigger: binding.requiresTrigger,
  };
}

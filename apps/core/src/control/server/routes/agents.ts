import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CreateAgentRequestSchema,
  AgentDmAccessRequestSchema,
  UpdateAgentRequestSchema,
} from '@myclaw/contracts';

import { AgentDmAccessAdministrationService } from '../../../application/agents/agent-dm-access-administration-service.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { Agent, AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

function dmAccessService(): AgentDmAccessAdministrationService {
  return new AgentDmAccessAdministrationService(
    getRuntimeStorage().repositories,
  );
}

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
      const dmAccess = await dmAccessService().getDmAccess({
        appId: auth.appId as AppId,
        agentId,
      });
      sendJson(res, 200, {
        agent: agentToResponse(agent),
        dmAccess: dmAccess.dmAccess,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const agentDmAccessMatch = pathname.match(
    /^\/v1\/agents\/([^/]+)\/dm-access$/,
  );
  if (agentDmAccessMatch && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = AgentDmAccessRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent DM access');
      return true;
    }
    try {
      const response = await dmAccessService().replaceDmAccess({
        appId: auth.appId as AppId,
        agentId: decodeURIComponent(agentDmAccessMatch[1]) as AgentId,
        entries: parsed.data.entries,
      });
      sendJson(res, 200, response);
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

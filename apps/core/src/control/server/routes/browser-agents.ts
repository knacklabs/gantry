import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { CustomRoleService } from '../../../application/agents/custom-role-service.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import type { Agent, AgentId, CustomRoleId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { nowIso } from '../../../shared/time/datetime.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { activeSession, requireBrowserMutationSession } from './browser-auth.js';

type BrowserAgentsSettings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

const AGENT_PATH = /^\/ui\/api\/agents\/([^/]+)$/;
const AGENT_STATUS_PATH = /^\/ui\/api\/agents\/([^/]+)\/(enable|disable)$/;
const ROLE_PATH = /^\/ui\/api\/roles\/([^/]+)$/;

export function isBrowserAgentsPath(pathname: string): boolean {
  return pathname.startsWith('/ui/api/agents') || pathname.startsWith('/ui/api/roles');
}

function pageParams(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 25));
  return { page, pageSize };
}

function page<T>(items: T[], pageNumber: number, pageSize: number) {
  const total = items.length;
  return { items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), page: pageNumber, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function agentView(agent: Agent) {
  return { id: agent.id, name: agent.name, status: agent.status, createdAt: agent.createdAt, updatedAt: agent.updatedAt };
}

function roleView(role: { id: string; name: string; prompt: string; sourceRoleId?: string; createdAt: string; updatedAt: string }) {
  return { id: role.id, name: role.name, prompt: role.prompt, sourceRoleId: role.sourceRoleId, createdAt: role.createdAt, updatedAt: role.updatedAt };
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function handleBrowserAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  url: URL,
  settings: BrowserAgentsSettings,
): Promise<boolean> {
  if (!isBrowserAgentsPath(pathname)) return false;
  const mode = settings.authentication.mode;
  const appIdFor = (session: { appId: string }) => session.appId as AppId;
  if (req.method === 'GET') {
    const session = await activeSession(req, mode);
    if (!session) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.'), true;
    if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin'))
      return sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.'), true;
    const storage = getRuntimeStorage();
    const appId = appIdFor(session);
    const { page: pageNumber, pageSize } = pageParams(url);
    if (pathname === '/ui/api/agents') {
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const status = url.searchParams.get('status');
      const agents = (await storage.repositories.agents.listAgents(appId))
        .filter((agent) => !search || agent.name.toLowerCase().includes(search))
        .filter((agent) => !status || agent.status === status)
        .sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, page(agents.map(agentView), pageNumber, pageSize));
      return true;
    }
    if (pathname === '/ui/api/roles') {
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const roles = (await storage.repositories.customRoles.listCustomRoles(appId))
        .filter((role) => !search || role.name.toLowerCase().includes(search));
      sendJson(res, 200, page(roles.map(roleView), pageNumber, pageSize));
      return true;
    }
    const agentMatch = pathname.match(AGENT_PATH);
    if (agentMatch) {
      const agent = await storage.repositories.agents.getAgent(decodeURIComponent(agentMatch[1]) as AgentId);
      if (!agent || agent.appId !== appId) return sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true;
      sendJson(res, 200, { agent: agentView(agent) });
      return true;
    }
    const roleMatch = pathname.match(ROLE_PATH);
    if (roleMatch) {
      const role = await storage.repositories.customRoles.getCustomRole(decodeURIComponent(roleMatch[1]) as CustomRoleId);
      if (!role || role.appId !== appId) return sendError(res, 404, 'NOT_FOUND', 'Role not found.'), true;
      sendJson(res, 200, { role: roleView(role) });
      return true;
    }
    return sendError(res, 404, 'NOT_FOUND', 'Browser agent route not found.'), true;
  }
  const session = await requireBrowserMutationSession({ req, res, mode, originIsValid: isCanonicalBrowserOrigin(req, settings.authentication.canonicalOrigin) });
  if (!session) return true;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) return sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.'), true;
  if (mode === 'hosted' && !isRecentlyReauthenticated(session.reauthenticatedAt)) return sendError(res, 401, 'REAUTHENTICATION_REQUIRED', 'Sign in again to continue.'), true;
  const storage = getRuntimeStorage();
  const appId = appIdFor(session);
  const actor = `browser:${session.userId}`;
  const roleService = new CustomRoleService(storage.repositories.customRoles);
  try {
    if (pathname === '/ui/api/agents' && req.method === 'POST') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name)) return sendError(res, 400, 'INVALID_REQUEST', 'Agent name is required.'), true;
      const now = nowIso();
      const agent: Agent = { id: `agent:${randomUUID()}` as AgentId, appId, name: body.name.trim(), status: 'active', createdAt: now, updatedAt: now };
      await storage.repositories.agents.saveAgent(agent);
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 201, { agent: agentView(agent) });
      return true;
    }
    const statusMatch = pathname.match(AGENT_STATUS_PATH);
    if (statusMatch && req.method === 'POST') {
      const agent = await storage.repositories.agents.getAgent(decodeURIComponent(statusMatch[1]) as AgentId);
      if (!agent || agent.appId !== appId) return sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true;
      const updated = statusMatch[2] === 'disable'
        ? await storage.repositories.agents.disableAgent({ appId, agentId: agent.id, updatedAt: nowIso() })
        : { ...agent, status: 'active' as const, updatedAt: nowIso() };
      if (statusMatch[2] === 'enable') await storage.repositories.agents.saveAgent(updated!);
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { agent: agentView(updated!) });
      return true;
    }
    if (pathname === '/ui/api/roles' && req.method === 'POST') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name) || !validName(body.prompt)) return sendError(res, 400, 'INVALID_REQUEST', 'Role name and prompt are required.'), true;
      const role = await roleService.create({ appId, name: body.name, prompt: body.prompt, sourceRoleId: typeof body.sourceRoleId === 'string' ? body.sourceRoleId : undefined });
      sendJson(res, 201, { role: roleView(role), actor });
      return true;
    }
    const roleMatch = pathname.match(ROLE_PATH);
    if (roleMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name) || !validName(body.prompt)) return sendError(res, 400, 'INVALID_REQUEST', 'Role name and prompt are required.'), true;
      const role = await roleService.update({ appId, id: decodeURIComponent(roleMatch[1]) as CustomRoleId, name: body.name, prompt: body.prompt, sourceRoleId: typeof body.sourceRoleId === 'string' ? body.sourceRoleId : undefined });
      sendJson(res, 200, { role: roleView(role) });
      return true;
    }
    if (roleMatch && req.method === 'DELETE') {
      await roleService.delete({ appId, id: decodeURIComponent(roleMatch[1]) as CustomRoleId });
      res.writeHead(204); res.end(); return true;
    }
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  } catch (error) {
    sendError(res, 400, 'INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid request.');
    return true;
  }
}

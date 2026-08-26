import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { CustomRoleService } from '../../../application/agents/custom-role-service.js';
import { builtInRolePrompt } from '../../../application/agents/prompt-profile-service.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import type {
  Agent,
  AgentConfigVersion,
  AgentConfigVersionId,
  AgentId,
  CustomRoleId,
} from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { nowIso } from '../../../shared/time/datetime.js';
import { AGENT_PERSONAS } from '../../../shared/agent-persona.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

type BrowserAgentsSettings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

const AGENT_PATH = /^\/ui\/api\/agents\/([^/]+)$/;
const AGENT_STATUS_PATH = /^\/ui\/api\/agents\/([^/]+)\/(enable|disable)$/;
const ROLE_PATH = /^\/ui\/api\/roles\/([^/]+)$/;

export function isBrowserAgentsPath(pathname: string): boolean {
  return (
    pathname.startsWith('/ui/api/agents') ||
    pathname.startsWith('/ui/api/roles')
  );
}

function pageParams(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get('pageSize')) || 25),
  );
  return { page, pageSize };
}

function page<T>(items: T[], pageNumber: number, pageSize: number) {
  const total = items.length;
  const end = pageNumber * pageSize;
  return {
    data: items.slice((pageNumber - 1) * pageSize, end),
    page: pageNumber,
    pageSize,
    total,
    hasNext: end < total,
  };
}

async function agentView(
  storage: ReturnType<typeof getRuntimeStorage>,
  agent: Agent,
) {
  const config = agent.currentConfigVersionId
    ? await storage.repositories.agentConfigs.getConfigVersion(
        agent.currentConfigVersionId,
      )
    : null;
  const installs =
    await storage.repositories.providerAccounts.listConversationInstalls(
      agent.appId,
      agent.id,
    );
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    roleName: config?.roleSnapshot?.displayName ?? null,
    rolePrompt: config?.roleSnapshot?.prompt ?? null,
    configVersion: config?.version ?? null,
    modelAlias: null,
    conversationCount: installs.filter((install) => install.status === 'active')
      .length,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

type BrowserRole = {
  id: string;
  name: string;
  prompt: string;
  kind: 'built-in' | 'custom';
  sourceRoleId?: string;
  createdAt?: string;
  updatedAt?: string;
};

function roleView(role: Omit<BrowserRole, 'kind'>): BrowserRole {
  return {
    id: role.id,
    name: role.name,
    prompt: role.prompt,
    kind: 'custom',
    sourceRoleId: role.sourceRoleId,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

function builtInRoles(): BrowserRole[] {
  return AGENT_PERSONAS.map((persona) => ({
    id: `built-in:${persona}`,
    name: `${persona[0].toUpperCase()}${persona.slice(1)}`,
    prompt: builtInRolePrompt(persona, 'full'),
    kind: 'built-in',
  }));
}

async function roleSnapshotFor(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
  roleId: string,
) {
  const builtIn = builtInRoles().find((role) => role.id === roleId);
  if (builtIn)
    return {
      displayName: builtIn.name,
      prompt: builtIn.prompt,
      sourceRoleId: builtIn.id,
    };
  const role = await storage.repositories.customRoles.getCustomRole(
    roleId as CustomRoleId,
  );
  if (!role || role.appId !== appId)
    throw new Error('Selected role not found.');
  return new CustomRoleService(storage.repositories.customRoles).snapshot(role);
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
    if (!session)
      return (
        sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.'),
        true
      );
    if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin'))
      return (
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.'),
        true
      );
    const storage = getRuntimeStorage();
    const appId = appIdFor(session);
    const { page: pageNumber, pageSize } = pageParams(url);
    if (pathname === '/ui/api/agents') {
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const status = url.searchParams.get('status');
      const role = url.searchParams.get('role')?.trim().toLowerCase() ?? '';
      const sort = url.searchParams.get('sort') ?? 'name';
      const direction = url.searchParams.get('direction') === 'desc' ? -1 : 1;
      const agents = await Promise.all(
        (await storage.repositories.agents.listAgents(appId)).map((agent) =>
          agentView(storage, agent),
        ),
      );
      const filtered = agents
        .filter((agent) => !search || agent.name.toLowerCase().includes(search))
        .filter((agent) => !status || agent.status === status)
        .filter((agent) => !role || agent.roleName?.toLowerCase() === role)
        .sort((a, b) => {
          const left =
            sort === 'status'
              ? a.status
              : sort === 'updatedAt'
                ? a.updatedAt
                : a.name;
          const right =
            sort === 'status'
              ? b.status
              : sort === 'updatedAt'
                ? b.updatedAt
                : b.name;
          return left.localeCompare(right) * direction;
        });
      sendJson(res, 200, page(filtered, pageNumber, pageSize));
      return true;
    }
    if (pathname === '/ui/api/roles') {
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const roles = [
        ...builtInRoles(),
        ...(await storage.repositories.customRoles.listCustomRoles(appId)).map(
          roleView,
        ),
      ]
        .filter((role) => !search || role.name.toLowerCase().includes(search))
        .sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, page(roles, pageNumber, pageSize));
      return true;
    }
    const agentMatch = pathname.match(AGENT_PATH);
    if (agentMatch) {
      const agent = await storage.repositories.agents.getAgent(
        decodeURIComponent(agentMatch[1]) as AgentId,
      );
      if (!agent || agent.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true);
      sendJson(res, 200, { agent: await agentView(storage, agent) });
      return true;
    }
    const roleMatch = pathname.match(ROLE_PATH);
    if (roleMatch) {
      const builtIn = builtInRoles().find(
        (role) => role.id === decodeURIComponent(roleMatch[1]),
      );
      if (builtIn) return (sendJson(res, 200, { role: builtIn }), true);
      const role = await storage.repositories.customRoles.getCustomRole(
        decodeURIComponent(roleMatch[1]) as CustomRoleId,
      );
      if (!role || role.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Role not found.'), true);
      sendJson(res, 200, { role: roleView(role) });
      return true;
    }
    return (
      sendError(res, 404, 'NOT_FOUND', 'Browser agent route not found.'),
      true
    );
  }
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return true;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin'))
    return (
      sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.'),
      true
    );
  if (
    mode === 'hosted' &&
    !isRecentlyReauthenticated(session.reauthenticatedAt)
  )
    return (
      sendError(
        res,
        401,
        'REAUTHENTICATION_REQUIRED',
        'Sign in again to continue.',
      ),
      true
    );
  const storage = getRuntimeStorage();
  const appId = appIdFor(session);
  const actor = `browser:${session.userId}`;
  const roleService = new CustomRoleService(storage.repositories.customRoles);
  try {
    if (pathname === '/ui/api/agents' && req.method === 'POST') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name))
        return (
          sendError(res, 400, 'INVALID_REQUEST', 'Agent name is required.'),
          true
        );
      const now = nowIso();
      const roleId =
        typeof body.roleId === 'string' ? body.roleId : 'built-in:developer';
      const configId = `agent-config:${randomUUID()}` as AgentConfigVersionId;
      const agent: Agent = {
        id: `agent:${randomUUID()}` as AgentId,
        appId,
        name: body.name.trim(),
        status: 'active',
        currentConfigVersionId: configId,
        createdAt: now,
        updatedAt: now,
      };
      const config: AgentConfigVersion = {
        id: configId,
        appId,
        agentId: agent.id,
        version: 1,
        promptProfileRef: 'browser-agent-role-snapshot',
        roleSnapshot: await roleSnapshotFor(storage, appId, roleId),
        // The control graph establishes this default profile for an app before
        // agents are available to configure.
        llmProfileId: 'llm:default' as AgentConfigVersion['llmProfileId'],
        toolIds: [],
        skillIds: [],
        permissionPolicyIds: [],
        createdAt: now,
      };
      await storage.repositories.agents.saveAgent(agent);
      await storage.repositories.agentConfigs.saveConfigVersion(config);
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 201, { agent: await agentView(storage, agent) });
      return true;
    }
    const statusMatch = pathname.match(AGENT_STATUS_PATH);
    if (statusMatch && req.method === 'POST') {
      const agent = await storage.repositories.agents.getAgent(
        decodeURIComponent(statusMatch[1]) as AgentId,
      );
      if (!agent || agent.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true);
      const updated =
        statusMatch[2] === 'disable'
          ? await storage.repositories.agents.disableAgent({
              appId,
              agentId: agent.id,
              updatedAt: nowIso(),
            })
          : { ...agent, status: 'active' as const, updatedAt: nowIso() };
      if (statusMatch[2] === 'enable')
        await storage.repositories.agents.saveAgent(updated!);
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { agent: await agentView(storage, updated!) });
      return true;
    }
    if (pathname === '/ui/api/roles' && req.method === 'POST') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name) || !validName(body.prompt))
        return (
          sendError(
            res,
            400,
            'INVALID_REQUEST',
            'Role name and prompt are required.',
          ),
          true
        );
      const role = await roleService.create({
        appId,
        name: body.name,
        prompt: body.prompt,
        sourceRoleId:
          typeof body.sourceRoleId === 'string' ? body.sourceRoleId : undefined,
      });
      sendJson(res, 201, { role: roleView(role), actor });
      return true;
    }
    const roleMatch = pathname.match(ROLE_PATH);
    if (roleMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name) || !validName(body.prompt))
        return (
          sendError(
            res,
            400,
            'INVALID_REQUEST',
            'Role name and prompt are required.',
          ),
          true
        );
      const role = await roleService.update({
        appId,
        id: decodeURIComponent(roleMatch[1]) as CustomRoleId,
        name: body.name,
        prompt: body.prompt,
        sourceRoleId:
          typeof body.sourceRoleId === 'string' ? body.sourceRoleId : undefined,
      });
      sendJson(res, 200, { role: roleView(role) });
      return true;
    }
    if (roleMatch && req.method === 'DELETE') {
      await roleService.delete({
        appId,
        id: decodeURIComponent(roleMatch[1]) as CustomRoleId,
      });
      res.writeHead(204);
      res.end();
      return true;
    }
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  } catch (error) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      error instanceof Error ? error.message : 'Invalid request.',
    );
    return true;
  }
}

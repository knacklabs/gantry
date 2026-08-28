import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { CustomRoleService } from '../../../application/agents/custom-role-service.js';
import { AgentCapabilityAdministrationService } from '../../../application/agents/agent-capability-administration-service.js';
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
import { listModelCatalogEntries } from '../../../shared/model-catalog.js';
import { semanticCapabilityFromToolCatalogItem } from '../../../shared/semantic-capabilities.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';
import {
  agentView,
  assertAvailableAgentName,
  builtInRoles,
  capabilityService,
  object,
  page,
  pageParams,
  requestedModelAlias,
  retainedAgentCounts,
  roleSnapshotFor,
  roleView,
  validName,
  validateModelAlias,
} from './browser-agents-helpers.js';

type BrowserAgentsSettings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

const AGENT_PATH = /^\/ui\/api\/agents\/([^/]+)$/;
const AGENT_STATUS_PATH = /^\/ui\/api\/agents\/([^/]+)\/(enable|disable)$/;
const AGENT_SOURCES_PATH = /^\/ui\/api\/agents\/([^/]+)\/sources$/;
const AGENT_CAPABILITIES_PATH = /^\/ui\/api\/agents\/([^/]+)\/capabilities$/;
const AGENT_VERSIONS_PATH = /^\/ui\/api\/agents\/([^/]+)\/versions$/;
const ROLE_PATH = /^\/ui\/api\/roles\/([^/]+)$/;
const AGENT_MODELS_PATH = '/ui/api/agent-models';

export function isBrowserAgentsPath(pathname: string): boolean {
  return (
    pathname.startsWith('/ui/api/agents') ||
    pathname.startsWith('/ui/api/roles') ||
    pathname === AGENT_MODELS_PATH
  );
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
    if (pathname === AGENT_MODELS_PATH) {
      const configured = new Set(
        await ctx.getActiveModelCredentialProviderIds(appId),
      );
      const models = listModelCatalogEntries()
        .filter(
          (entry) =>
            entry.supportedWorkloads.includes('chat') &&
            configured.has(entry.modelRoute.id),
        )
        .map((entry) => ({
          alias: entry.recommendedAlias,
          displayName: entry.displayName,
          providerId: entry.modelRoute.id,
          providerLabel: entry.modelRoute.label,
        }));
      sendJson(res, 200, { models });
      return true;
    }
    if (pathname === '/ui/api/agents') {
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const status = url.searchParams.get('status');
      const role = url.searchParams.get('role')?.trim().toLowerCase() ?? '';
      const sort = url.searchParams.get('sort') ?? 'name';
      const direction = url.searchParams.get('direction') === 'desc' ? -1 : 1;
      const pageInput = {
        appId,
        page: pageNumber,
        pageSize,
        search: search || undefined,
        status:
          status === 'active' || status === 'disabled'
            ? (status as 'active' | 'disabled')
            : undefined,
        role: role || undefined,
        sort:
          sort === 'status' || sort === 'updatedAt'
            ? (sort as 'status' | 'updatedAt')
            : ('name' as const),
        direction: direction === -1 ? ('desc' as const) : ('asc' as const),
      };
      const paged =
        await storage.repositories.agents.listAgentsPage?.(pageInput);
      const agents = await Promise.all(
        (
          paged?.data ?? (await storage.repositories.agents.listAgents(appId))
        ).map((agent) => agentView(storage, agent)),
      );
      const filtered = paged
        ? agents
        : agents
            .filter(
              (agent) => !search || agent.name.toLowerCase().includes(search),
            )
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
      sendJson(
        res,
        200,
        paged
          ? {
              data: filtered,
              page: pageNumber,
              pageSize,
              total: paged.total,
              hasNext: pageNumber * pageSize < paged.total,
            }
          : page(filtered, pageNumber, pageSize),
      );
      return true;
    }
    if (pathname === '/ui/api/roles') {
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const kind = url.searchParams.get('kind');
      const counts =
        kind === 'built-in'
          ? new Map<string, number>()
          : await retainedAgentCounts(storage, appId);
      const roles = [
        ...(kind !== 'custom' ? builtInRoles() : []),
        ...(kind !== 'built-in'
          ? (await storage.repositories.customRoles.listCustomRoles(appId)).map(
              roleView,
            )
          : []),
      ]
        .filter((role) => !search || role.name.toLowerCase().includes(search))
        .map((role) => ({
          ...role,
          retainedAgentCount: counts.get(role.id) ?? 0,
        }))
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
    const sourcesMatch = pathname.match(AGENT_SOURCES_PATH);
    if (sourcesMatch) {
      const agentId = decodeURIComponent(sourcesMatch[1]) as AgentId;
      const agent = await storage.repositories.agents.getAgent(agentId);
      if (!agent || agent.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true);
      const catalogKind = url.searchParams.get('catalog');
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      if (catalogKind === 'skills' || catalogKind === 'mcp') {
        const catalog = await capabilityService(storage).listCatalog(appId);
        const items = (
          catalogKind === 'skills'
            ? catalog.skills.map((skill) => ({
                ...skill,
                status: 'installed' as const,
              }))
            : catalog.mcpServers.map((server) => ({
                ...server,
                status: server.status,
              }))
        )
          .filter(
            (item) =>
              !search ||
              `${item.name} ${item.description ?? ''}`
                .toLowerCase()
                .includes(search),
          )
          .sort((left, right) => left.name.localeCompare(right.name));
        sendJson(res, 200, { catalog: page(items, pageNumber, pageSize) });
        return true;
      }
      const sources = await capabilityService(storage).getSources({
        appId,
        agentId,
      });
      sendJson(res, 200, { sources });
      return true;
    }
    const capabilitiesMatch = pathname.match(AGENT_CAPABILITIES_PATH);
    if (capabilitiesMatch) {
      const agentId = decodeURIComponent(capabilitiesMatch[1]) as AgentId;
      const agent = await storage.repositories.agents.getAgent(agentId);
      if (!agent || agent.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true);
      const [capabilities, catalog] = await Promise.all([
        capabilityService(storage).getCapabilities({ appId, agentId }),
        capabilityService(storage).listCatalog(appId),
      ]);
      const catalogKind = url.searchParams.get('catalog');
      const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const catalogItems = catalog.tools.flatMap((tool) => {
        const capability = semanticCapabilityFromToolCatalogItem({
          name: tool.name,
          inputSchema: tool.inputSchema,
        });
        return capability
          ? [
              {
                id: capability.capabilityId,
                version: capability.version,
                label: tool.displayName,
                description: tool.description,
                risk: tool.risk,
              },
            ]
          : [];
      });
      if (catalogKind === 'capabilities') {
        const items = catalogItems
          .filter(
            (item) =>
              !search ||
              `${item.label} ${item.description ?? ''}`
                .toLowerCase()
                .includes(search),
          )
          .sort((left, right) => left.label.localeCompare(right.label));
        sendJson(res, 200, { catalog: page(items, pageNumber, pageSize) });
        return true;
      }
      sendJson(res, 200, {
        capabilities: { capabilities: capabilities.capabilities },
        catalog: {
          capabilities: catalogItems.filter((item) =>
            capabilities.capabilities.some(
              (selected) =>
                selected.id === item.id && selected.version === item.version,
            ),
          ),
        },
      });
      return true;
    }
    const versionsMatch = pathname.match(AGENT_VERSIONS_PATH);
    if (versionsMatch) {
      const agentId = decodeURIComponent(versionsMatch[1]) as AgentId;
      const agent = await storage.repositories.agents.getAgent(agentId);
      if (!agent || agent.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true);
      const versions =
        await storage.repositories.agentConfigs.listConfigVersions({
          appId,
          agentId,
        });
      sendJson(res, 200, {
        versions: versions.map((version) => ({
          id: version.id,
          version: version.version,
          createdAt: version.createdAt,
          agentNameSnapshot: version.agentNameSnapshot,
          roleSnapshot: version.roleSnapshot,
          modelAliasSnapshot: version.modelAliasSnapshot ?? null,
          llmProfileId: version.llmProfileId,
        })),
      });
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
      await assertAvailableAgentName(storage, appId, body.name);
      const roleId =
        typeof body.roleId === 'string' ? body.roleId : 'built-in:developer';
      const modelAlias = requestedModelAlias(body);
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
      if (modelAlias !== undefined)
        await validateModelAlias(ctx, appId, agent.id, modelAlias);
      const config: AgentConfigVersion = {
        id: configId,
        appId,
        agentId: agent.id,
        version: 1,
        promptProfileRef: 'browser-agent-role-snapshot',
        agentNameSnapshot: agent.name,
        roleSnapshot: await roleSnapshotFor(storage, appId, roleId),
        modelAliasSnapshot: modelAlias ?? undefined,
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
      if (modelAlias !== undefined) {
        await ctx.agentSettings.writeAgentModelSetting({
          runtimeHome: ctx.runtimeHome,
          appId,
          folder: agent.id.replace(/^agent:/, ''),
          name: agent.name,
          modelAlias,
        });
      }
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 201, { agent: await agentView(storage, agent) });
      return true;
    }
    const agentMatch = pathname.match(AGENT_PATH);
    if (agentMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!object(body) || !validName(body.name))
        return (
          sendError(res, 400, 'INVALID_REQUEST', 'Agent name is required.'),
          true
        );
      const agent = await storage.repositories.agents.getAgent(
        decodeURIComponent(agentMatch[1]) as AgentId,
      );
      if (!agent || agent.appId !== appId)
        return (sendError(res, 404, 'NOT_FOUND', 'Agent not found.'), true);
      await assertAvailableAgentName(storage, appId, body.name, agent.id);
      const now = nowIso();
      let updated = { ...agent, name: body.name.trim(), updatedAt: now };
      const roleId = typeof body.roleId === 'string' ? body.roleId : undefined;
      const modelAlias = requestedModelAlias(body);
      const nameChanged = updated.name !== agent.name;
      const currentConfig =
        nameChanged || roleId || modelAlias !== undefined
          ? agent.currentConfigVersionId
            ? await storage.repositories.agentConfigs.getConfigVersion(
                agent.currentConfigVersionId,
              )
            : null
          : null;
      const roleChanged =
        !!roleId && currentConfig?.roleSnapshot?.sourceRoleId !== roleId;
      const modelChanged =
        modelAlias !== undefined &&
        (currentConfig?.modelAliasSnapshot ?? null) !== modelAlias;
      if (modelChanged)
        await validateModelAlias(ctx, appId, agent.id, modelAlias ?? null);
      if (nameChanged || roleChanged || modelChanged) {
        if (!currentConfig && !roleId)
          return (
            sendError(
              res,
              409,
              'CONFLICT',
              'Agent configuration could not be found.',
            ),
            true
          );
        const configVersions =
          await storage.repositories.agentConfigs.listConfigVersions({
            appId,
            agentId: agent.id,
          });
        const nextConfigVersion =
          Math.max(...configVersions.map((version) => version.version), 0) + 1;
        const nextConfig: AgentConfigVersion = currentConfig
          ? {
              ...currentConfig,
              id: `agent-config:${randomUUID()}` as AgentConfigVersionId,
              version: nextConfigVersion,
              agentNameSnapshot: updated.name,
              roleSnapshot: roleChanged
                ? await roleSnapshotFor(storage, appId, roleId!)
                : currentConfig.roleSnapshot,
              modelAliasSnapshot: modelChanged
                ? (modelAlias ?? undefined)
                : currentConfig.modelAliasSnapshot,
              createdAt: now,
            }
          : {
              id: `agent-config:${randomUUID()}` as AgentConfigVersionId,
              appId,
              agentId: agent.id,
              version: nextConfigVersion,
              promptProfileRef: 'browser-agent-role-snapshot',
              agentNameSnapshot: updated.name,
              roleSnapshot: await roleSnapshotFor(storage, appId, roleId!),
              modelAliasSnapshot: modelAlias ?? undefined,
              llmProfileId: 'llm:default' as AgentConfigVersion['llmProfileId'],
              toolIds: [],
              skillIds: [],
              permissionPolicyIds: [],
              createdAt: now,
            };
        await storage.repositories.agentConfigs.saveConfigVersion(nextConfig);
        updated = { ...updated, currentConfigVersionId: nextConfig.id };
      }
      await storage.repositories.agents.saveAgent(updated);
      if (modelChanged) {
        await ctx.agentSettings.writeAgentModelSetting({
          runtimeHome: ctx.runtimeHome,
          appId,
          folder: agent.id.replace(/^agent:/, ''),
          name: updated.name,
          modelAlias: modelAlias ?? null,
        });
      }
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { agent: await agentView(storage, updated) });
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
    const sourcesMatch = pathname.match(AGENT_SOURCES_PATH);
    if (sourcesMatch && req.method === 'PUT') {
      const body = await readJson(req);
      if (!object(body) || !object(body.sources))
        return (
          sendError(res, 400, 'INVALID_REQUEST', 'Sources are required.'),
          true
        );
      const agentId = decodeURIComponent(sourcesMatch[1]) as AgentId;
      const sources = await capabilityService(storage).replaceSources({
        appId,
        agentId,
        sources: body.sources as Parameters<
          AgentCapabilityAdministrationService['replaceSources']
        >[0]['sources'],
      });
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { sources });
      return true;
    }
    const capabilitiesMatch = pathname.match(AGENT_CAPABILITIES_PATH);
    if (capabilitiesMatch && req.method === 'PUT') {
      const body = await readJson(req);
      if (!object(body) || !Array.isArray(body.capabilities))
        return (
          sendError(res, 400, 'INVALID_REQUEST', 'Capabilities are required.'),
          true
        );
      const capabilities = await capabilityService(storage).replaceCapabilities(
        {
          appId,
          agentId: decodeURIComponent(capabilitiesMatch[1]) as AgentId,
          capabilities: body.capabilities as Array<{
            id: string;
            version: string;
          }>,
        },
      );
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { capabilities });
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
      const roleId = decodeURIComponent(roleMatch[1]) as CustomRoleId;
      const counts = await retainedAgentCounts(storage, appId);
      await roleService.delete({
        appId,
        id: roleId,
      });
      sendJson(res, 200, { retainedAgentCount: counts.get(roleId) ?? 0 });
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

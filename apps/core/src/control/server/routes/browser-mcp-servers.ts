import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ConnectMcpServerRequestSchema,
  DisableMcpServerRequestSchema,
  TestMcpServerRequestSchema,
  UpdateAgentMcpServerBindingRequestSchema,
} from '@gantry/contracts';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import {
  isRecentlyReauthenticated,
  type ConsoleRole,
} from '../../../application/auth/auth-foundations.js';
import { McpServerService } from '../../../application/mcp/mcp-server-service.js';
import { defaultHostnameLookup } from '../../../infrastructure/network/hostname-lookup.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  McpServerDefinition,
  McpServerId,
} from '../../../domain/mcp/mcp-servers.js';
import type { ControlRouteContext } from '../handler-context.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

type BrowserMcpSettings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

const BROWSER_AGENT_MCP_SERVER_PATH =
  /^\/ui\/api\/agents\/([^/]+)\/mcp-servers\/([^/]+)$/;

export function isBrowserMcpServerPath(pathname: string): boolean {
  return (
    pathname.startsWith('/ui/api/mcp-servers') ||
    BROWSER_AGENT_MCP_SERVER_PATH.test(pathname)
  );
}

function service() {
  const storage = getRuntimeStorage();
  return new McpServerService(
    storage.repositories.mcpServers,
    storage.repositories.agents,
    { lookupHostname: defaultHostnameLookup },
  );
}

export async function handleBrowserMcpServerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserMcpSettings,
): Promise<boolean> {
  if (!isBrowserMcpServerPath(pathname)) return false;
  const mode = settings.authentication.mode;
  const appIdFor = (session: { appId: string }) => session.appId as AppId;
  if (pathname === '/ui/api/mcp-servers' && req.method === 'GET') {
    const session = await activeSession(req, mode);
    if (!session)
      return sendBrowserError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    if (!browserRoleAllowsScope(session.role as ConsoleRole, 'mcp:read'))
      return sendBrowserError(
        res,
        403,
        'FORBIDDEN',
        'Viewer access is required.',
      );
    const storage = getRuntimeStorage();
    const appId = appIdFor(session);
    const [servers, agents] = await Promise.all([
      service().listServers({ appId, limit: 500 }),
      storage.repositories.agents.listAgents(appId),
    ]);
    const bindings = await Promise.all(
      agents.map(async (agent) => ({
        agent,
        bindings: await service().listAgentBindings({
          appId,
          agentId: agent.id,
          limit: 500,
        }),
      })),
    );
    sendJson(res, 200, {
      role: session.role,
      servers: servers.map((server) =>
        browserServer(
          server,
          bindings.flatMap(({ agent, bindings: rows }) =>
            rows
              .filter(
                (binding) =>
                  binding.serverId === server.id && binding.status === 'active',
              )
              .map((binding) => ({
                agentId: agent.id,
                name: agent.name,
                binding,
              })),
          ),
        ),
      ),
      agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
    });
    return true;
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
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'mcp:admin'))
    return sendBrowserError(
      res,
      403,
      'FORBIDDEN',
      'Administrator access is required.',
    );
  if (
    mode === 'hosted' &&
    !isRecentlyReauthenticated(session.reauthenticatedAt)
  )
    return sendBrowserError(
      res,
      401,
      'REAUTHENTICATION_REQUIRED',
      'Sign in again to continue.',
    );
  const appId = appIdFor(session);
  try {
    if (pathname === '/ui/api/mcp-servers' && req.method === 'POST') {
      const parsed = ConnectMcpServerRequestSchema.safeParse(
        await readJson(req),
      );
      if (!parsed.success || (parsed.data.appId && parsed.data.appId !== appId))
        return sendBrowserError(
          res,
          400,
          'INVALID_REQUEST',
          'Invalid MCP server connect.',
        );
      const server = await service().connectServer({
        appId,
        name: parsed.data.name,
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        createdBy: `browser:${session.userId}`,
        requestedReason: parsed.data.requestedReason,
        transportConfig: parsed.data.config,
        allowedToolPatterns: parsed.data.allowedToolPatterns,
        autoApproveToolPatterns: parsed.data.autoApproveToolPatterns,
        credentialRefs: parsed.data.credentialRefs,
        networkHosts: parsed.data.networkHosts,
        sandboxProfileId: parsed.data.sandboxProfileId,
        riskClass: parsed.data.riskClass,
      });
      sendJson(res, 201, { server: browserServer(server, []) });
      return true;
    }
    const action = pathname.match(
      /^\/ui\/api\/mcp-servers\/([^/]+)\/(test|disable)$/,
    );
    if (action && req.method === 'POST') {
      const serverId = decodeURIComponent(action[1]) as McpServerId;
      if (action[2] === 'test') {
        const parsed = TestMcpServerRequestSchema.safeParse(
          await readJson(req),
        );
        if (
          !parsed.success ||
          (parsed.data.appId && parsed.data.appId !== appId)
        )
          return sendBrowserError(
            res,
            400,
            'INVALID_REQUEST',
            'Invalid MCP server test.',
          );
        const result = await service().testServer({
          appId,
          serverId,
          testedBy: `browser:${session.userId}`,
        });
        sendJson(res, 200, {
          ok: result.ok,
          message: result.message,
          server: browserServer(result.server, []),
        });
        return true;
      }
      const parsed = DisableMcpServerRequestSchema.safeParse(
        await readJson(req),
      );
      if (!parsed.success || (parsed.data.appId && parsed.data.appId !== appId))
        return sendBrowserError(
          res,
          400,
          'INVALID_REQUEST',
          'Invalid MCP server disable.',
        );
      const server = await service().disableServer({
        appId,
        serverId,
        disabledBy: `browser:${session.userId}`,
        reason: parsed.data.reason,
      });
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { server: browserServer(server, []) });
      return true;
    }
    const binding = pathname.match(
      /^\/ui\/api\/mcp-servers\/([^/]+)\/agents\/([^/]+)$/,
    );
    if (binding && ['PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const serverId = decodeURIComponent(binding[1]) as McpServerId;
      const agentId = decodeURIComponent(binding[2]) as AgentId;
      if (req.method === 'DELETE') {
        const result = await service().unbindFromAgent({
          appId,
          agentId,
          serverId,
        });
        await ctx.syncSettingsFromProjection(appId);
        sendJson(res, 200, {
          binding: result ? browserBinding(result) : null,
        });
        return true;
      }
      const parsed = UpdateAgentMcpServerBindingRequestSchema.safeParse(
        await readJson(req),
      );
      if (!parsed.success || (parsed.data.appId && parsed.data.appId !== appId))
        return sendBrowserError(
          res,
          400,
          'INVALID_REQUEST',
          'Invalid MCP server binding.',
        );
      const result = await service().bindToAgent({
        appId,
        agentId,
        serverId,
        required: parsed.data.required,
        allowedToolPatterns: parsed.data.allowedToolPatterns,
      });
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { binding: browserBinding(result) });
      return true;
    }
  } catch (error) {
    return sendBrowserError(
      res,
      400,
      'INVALID_REQUEST',
      error instanceof Error ? error.message : 'Invalid MCP server request.',
    );
  }
  return sendBrowserError(res, 404, 'NOT_FOUND', 'MCP server route not found.');
}

function browserBinding(binding: AgentMcpServerBinding) {
  return {
    status: binding.status,
    required: binding.required,
    allowedToolPatterns: binding.allowedToolPatterns,
  };
}

function browserServer(
  server: McpServerDefinition,
  bindings: Array<{
    agentId: string;
    name: string;
    binding: {
      status: string;
      required: boolean;
      allowedToolPatterns: string[];
    };
  }>,
) {
  return {
    id: server.id,
    name: server.name,
    displayName: server.displayName,
    description: server.description,
    status: server.status,
    createdSource: server.createdSource,
    riskClass: server.riskClass,
    transport: server.transport,
    endpoint: server.config.url,
    templateId: server.config.templateId,
    args: server.config.args,
    allowedToolPatterns: server.allowedToolPatterns,
    credentialRefs: server.credentialRefs,
    networkHosts: server.networkHosts,
    sandboxProfileId: server.sandboxProfileId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    bindings,
  };
}

function sendBrowserError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): true {
  sendError(res, status, code, message);
  return true;
}

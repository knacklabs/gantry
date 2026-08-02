import { ConnectMcpServerRequestSchema, DisableMcpServerRequestSchema, TestMcpServerRequestSchema, UpdateAgentMcpServerBindingRequestSchema, } from '@gantry/contracts';
import { McpServerService } from '../../../application/mcp/mcp-server-service.js';
import { McpToolProxy } from '../../../application/mcp/mcp-tool-proxy.js';
import { resolveAgentToolRuntimePolicy } from '../../../application/agents/agent-tool-runtime-rules.js';
import { resolveMcpCredentialEnvForAgent } from '../../../application/capability-secrets/mcp-secret-projection.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { defaultHostnameLookup } from '../../../infrastructure/network/hostname-lookup.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { reviewedExternalMcpToolNamesFromRuntimeAccess } from '../../../shared/capability-runtime-access.js';
import { authorizeControlRequest, } from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
function service() {
    const storage = getRuntimeStorage();
    return new McpServerService(storage.repositories.mcpServers, storage.repositories.agents, { lookupHostname: defaultHostnameLookup });
}
export async function handleMcpServerRoutes(req, res, ctx, url, pathname) {
    if (pathname === '/v1/mcp-servers' && req.method === 'POST') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['mcp:admin']);
        if (!auth)
            return true;
        const parsed = ConnectMcpServerRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid MCP server connect');
            return true;
        }
        if (parsed.data.appId && parsed.data.appId !== auth.appId) {
            sendError(res, 403, 'FORBIDDEN', 'API key cannot create MCP servers for this app');
            return true;
        }
        try {
            const server = await service().connectServer({
                appId: auth.appId,
                name: parsed.data.name,
                displayName: parsed.data.displayName,
                description: parsed.data.description,
                createdBy: parsed.data.createdBy,
                requestedReason: parsed.data.requestedReason,
                transportConfig: parsed.data.config,
                allowedToolPatterns: parsed.data.allowedToolPatterns,
                autoApproveToolPatterns: parsed.data.autoApproveToolPatterns,
                credentialRefs: parsed.data.credentialRefs,
                networkHosts: parsed.data.networkHosts,
                sandboxProfileId: parsed.data.sandboxProfileId,
                riskClass: parsed.data.riskClass,
            });
            sendJson(res, 201, { server: serverToResponse(server) });
        }
        catch (error) {
            sendRouteError(res, error, 'MCP server connect failed');
        }
        return true;
    }
    if (pathname === '/v1/mcp-servers' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['mcp:read']);
        if (!auth)
            return true;
        const status = url.searchParams.get('status');
        const statuses = status === 'active' || status === 'disabled'
            ? [status]
            : undefined;
        try {
            const page = parsePage(url);
            const servers = await service().listServers({
                appId: auth.appId,
                statuses,
                limit: page.limit + 1,
                cursor: page.cursor,
            });
            sendJson(res, 200, pageResponse('servers', servers, page.limit, serverToResponse));
        }
        catch (error) {
            sendRouteError(res, error, 'MCP server lookup failed');
        }
        return true;
    }
    const serverMatch = pathname.match(/^\/v1\/mcp-servers\/([^/]+)$/);
    if (serverMatch && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['mcp:read']);
        if (!auth)
            return true;
        try {
            const server = await service().requireServer(auth.appId, decodeURIComponent(serverMatch[1]));
            sendJson(res, 200, { server: serverToResponse(server) });
        }
        catch (error) {
            sendRouteError(res, error, 'MCP server lookup failed');
        }
        return true;
    }
    const disableMatch = pathname.match(/^\/v1\/mcp-servers\/([^/]+)\/disable$/);
    if (disableMatch && req.method === 'POST') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['mcp:admin']);
        if (!auth)
            return true;
        const parsed = DisableMcpServerRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid MCP server disable request');
            return true;
        }
        if (parsed.data.appId && parsed.data.appId !== auth.appId) {
            sendError(res, 403, 'FORBIDDEN', 'API key cannot disable MCP servers for this app');
            return true;
        }
        try {
            const server = await service().disableServer({
                appId: auth.appId,
                serverId: decodeURIComponent(disableMatch[1]),
                disabledBy: parsed.data.disabledBy,
                reason: parsed.data.reason,
            });
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, { server: serverToResponse(server) });
        }
        catch (error) {
            sendRouteError(res, error, 'MCP server disable failed');
        }
        return true;
    }
    const testMatch = pathname.match(/^\/v1\/mcp-servers\/([^/]+)\/test$/);
    if (testMatch && req.method === 'POST') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['mcp:admin']);
        if (!auth)
            return true;
        const parsed = TestMcpServerRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid MCP server test request');
            return true;
        }
        if (parsed.data.appId && parsed.data.appId !== auth.appId) {
            sendError(res, 403, 'FORBIDDEN', 'API key cannot test MCP servers for this app');
            return true;
        }
        try {
            const result = await service().testServer({
                appId: auth.appId,
                serverId: decodeURIComponent(testMatch[1]),
                testedBy: parsed.data.testedBy,
            });
            const diagnostics = parsed.data.agentId
                ? await mcpCapabilityDriftDiagnostics({
                    appId: auth.appId,
                    agentId: parsed.data.agentId,
                    server: result.server,
                    egressDenylist: ctx.getEgressSettings?.().denylist ?? [],
                })
                : undefined;
            sendJson(res, 200, {
                ok: result.ok,
                message: doctorMessage(result.message, diagnostics),
                server: serverToResponse(result.server),
                ...(diagnostics ? { diagnostics } : {}),
            });
        }
        catch (error) {
            sendRouteError(res, error, 'MCP server test failed');
        }
        return true;
    }
    const agentMcpMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/mcp-servers\/([^/]+)$/);
    if (agentMcpMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'mcp:admin',
            'agents:admin',
        ]);
        if (!auth)
            return true;
        const parsed = UpdateAgentMcpServerBindingRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent MCP server binding');
            return true;
        }
        if (parsed.data.appId && parsed.data.appId !== auth.appId) {
            sendError(res, 403, 'FORBIDDEN', 'API key cannot bind MCP servers for this app');
            return true;
        }
        const appId = auth.appId;
        const agentId = decodeURIComponent(agentMcpMatch[1]);
        const serverId = decodeURIComponent(agentMcpMatch[2]);
        const mcpService = service();
        let binding;
        try {
            binding = await mcpService.bindToAgent({
                appId,
                agentId,
                serverId,
                required: parsed.data.required,
                permissionPolicyIds: parsed.data.permissionPolicyIds,
                allowedToolPatterns: parsed.data.allowedToolPatterns,
            });
            await ctx.syncSettingsFromProjection(appId);
            sendJson(res, 200, { binding: bindingToResponse(binding) });
        }
        catch (error) {
            if (binding) {
                await mcpService
                    .unbindFromAgent({
                    appId,
                    agentId,
                    serverId,
                })
                    .catch(() => undefined);
            }
            sendRouteError(res, error, 'MCP server binding failed');
        }
        return true;
    }
    if (agentMcpMatch && req.method === 'DELETE') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'mcp:admin',
            'agents:admin',
        ]);
        if (!auth)
            return true;
        try {
            const binding = await service().unbindFromAgent({
                appId: auth.appId,
                agentId: decodeURIComponent(agentMcpMatch[1]),
                serverId: decodeURIComponent(agentMcpMatch[2]),
            });
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, {
                disabled: Boolean(binding),
                binding: binding ? bindingToResponse(binding) : null,
            });
        }
        catch (error) {
            sendRouteError(res, error, 'MCP server unbinding failed');
        }
        return true;
    }
    const agentMcpsMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/mcp-servers$/);
    if (agentMcpsMatch && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['mcp:read']);
        if (!auth)
            return true;
        try {
            const page = parsePage(url);
            const bindings = await service().listAgentBindings({
                appId: auth.appId,
                agentId: decodeURIComponent(agentMcpsMatch[1]),
                limit: page.limit + 1,
                cursor: page.cursor,
            });
            sendJson(res, 200, pageResponse('bindings', bindings, page.limit, bindingToResponse));
        }
        catch (error) {
            sendRouteError(res, error, 'Agent MCP server lookup failed');
        }
        return true;
    }
    return false;
}
async function mcpCapabilityDriftDiagnostics(input) {
    const storage = getRuntimeStorage();
    const credentialEnv = await resolveMcpCredentialEnvForAgent({
        appId: input.appId,
        agentId: input.agentId,
        mcpServers: storage.repositories.mcpServers,
        secrets: storage.repositories.capabilitySecrets,
        serverIds: [input.server.id],
    });
    const proxy = new McpToolProxy(storage.repositories.mcpServers, {
        tools: storage.repositories.tools,
        skills: storage.repositories.skills,
        credentialEnv,
        sourceServerIds: [input.server.id],
        lookupHostname: defaultHostnameLookup,
        egressDenylist: input.egressDenylist,
    });
    const [inventory, policy] = await Promise.all([
        proxy.listTools({
            appId: input.appId,
            agentId: input.agentId,
            serverName: input.server.name,
            limit: 50,
        }),
        resolveAgentToolRuntimePolicy({
            repository: storage.repositories.tools,
            skillRepository: storage.repositories.skills,
            appId: input.appId,
            agentId: input.agentId,
            errorSubject: 'Configured agent tool',
        }),
    ]);
    const visibleTools = inventory.servers.flatMap((server) => server.tools.map((tool) => `mcp__${server.name}__${tool.name}`));
    const approvedTools = reviewedExternalMcpToolNamesFromRuntimeAccess(policy.runtimeAccess, { serverNames: [input.server.name] }).sort();
    const approved = new Set(approvedTools);
    const blockedByCapabilityReview = visibleTools
        .filter((tool) => !approved.has(tool))
        .sort();
    return {
        agentId: input.agentId,
        serverName: input.server.name,
        visibleTools: [...visibleTools].sort(),
        approvedTools,
        blockedByCapabilityReview,
        ...(inventory.diagnostics.remoteListTruncated
            ? { inventoryTruncated: true }
            : {}),
        ...(blockedByCapabilityReview.length > 0
            ? {
                warning: 'MCP source is healthy, but some visible tools are not approved by selected agent capabilities. Review semantic capability implementationBindings before users call them.',
            }
            : {}),
    };
}
function doctorMessage(message, diagnostics) {
    const count = diagnostics?.blockedByCapabilityReview.length ?? 0;
    if (count === 0)
        return message;
    return `${message} ${count} visible MCP tool(s) are blocked by missing semantic capability bindings.`;
}
function parsePage(url) {
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
    if (!Number.isFinite(rawLimit) || rawLimit < 1) {
        throw new ApplicationError('INVALID_REQUEST', 'limit must be a positive integer');
    }
    return {
        limit: Math.min(rawLimit, 500),
        cursor: url.searchParams.get('cursor') || undefined,
    };
}
function pageResponse(key, rows, limit, project) {
    const pageRows = rows.slice(0, limit);
    const lastRow = rows.length > limit ? pageRows.at(-1) : undefined;
    return {
        [key]: pageRows.map(project),
        nextCursor: cursorForRow(lastRow),
    };
}
function cursorForRow(row) {
    if (!row || typeof row !== 'object')
        return undefined;
    const record = row;
    return typeof record.updatedAt === 'string'
        ? record.updatedAt
        : typeof record.createdAt === 'string'
            ? record.createdAt
            : undefined;
}
function sendRouteError(res, error, fallback) {
    if (error instanceof ApplicationError) {
        const status = error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'FORBIDDEN'
                ? 403
                : error.code === 'CONFLICT'
                    ? 409
                    : 400;
        sendError(res, status, error.code, error.message);
        return;
    }
    sendError(res, 400, 'INVALID_REQUEST', error instanceof Error ? error.message : fallback);
}
function serverToResponse(server) {
    return { ...server };
}
function bindingToResponse(binding) {
    return { ...binding };
}

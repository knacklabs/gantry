import { assertNoRawSecretsInMcpConfig, assertValidMcpServerName, isMcpServerActive, normalizeMcpServerName, } from '../../domain/mcp/mcp-servers.js';
import { ApplicationError } from '../common/application-error.js';
import { assertRemoteMcpDestinationPublic, normalizeAgentMcpToolScope, normalizeCredentialRefs, normalizeMcpNetworkHosts, validateCredentialRefs, validateTransportConfig, } from './mcp-server-policy.js';
import { reviewedMcpToolPatterns } from '../../shared/mcp-tool-scope.js';
import { materializeMcpRecord, } from './mcp-server-materialization.js';
import { nowIso } from '../../shared/time/datetime.js';
export class McpServerService {
    mcpServers;
    agents;
    options;
    constructor(mcpServers, agents, options = {}) {
        this.mcpServers = mcpServers;
        this.agents = agents;
        this.options = options;
    }
    async connectServer(input) {
        const name = normalizeMcpServerName(input.name);
        assertValidMcpServerName(name);
        validateTransportConfig(input.transportConfig, {
            sandboxProfileId: input.sandboxProfileId,
        });
        const networkHosts = normalizeMcpNetworkHosts({
            serverName: name,
            networkHosts: input.networkHosts,
            config: input.transportConfig,
        });
        assertNoRawSecretsInMcpConfig(input.transportConfig);
        validateCredentialRefs(input.credentialRefs ?? []);
        validateToolPatternPolicy({
            allowedToolPatterns: input.allowedToolPatterns ?? [],
            autoApproveToolPatterns: input.autoApproveToolPatterns ?? [],
        });
        await assertRemoteMcpDestinationPublic(input.transportConfig, this.options.lookupHostname, {
            cache: this.options.dnsValidationCache,
            lookupTimeoutMs: this.options.dnsLookupTimeoutMs,
        });
        const existing = await this.mcpServers.getServerByName({
            appId: input.appId,
            name,
        });
        if (existing && isMcpServerActive(existing)) {
            throw new ApplicationError('CONFLICT', `MCP server already exists: ${name}`);
        }
        const now = nowIso();
        const serverId = existing?.id ?? `mcp:${globalThis.crypto.randomUUID()}`;
        const definition = {
            id: serverId,
            appId: input.appId,
            name,
            displayName: input.displayName,
            description: input.description,
            status: 'active',
            createdSource: input.createdSource ?? 'admin',
            riskClass: input.riskClass ?? 'medium',
            requestedBy: input.createdBy,
            requestedReason: input.requestedReason,
            transport: input.transportConfig.transport,
            config: input.transportConfig,
            allowedToolPatterns: input.allowedToolPatterns ?? [],
            autoApproveToolPatterns: input.autoApproveToolPatterns ?? [],
            credentialRefs: normalizeCredentialRefs(input.credentialRefs ?? []),
            networkHosts,
            sandboxProfileId: input.sandboxProfileId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await this.mcpServers.saveServer(definition);
        await this.audit({
            appId: input.appId,
            serverId,
            eventType: 'connect',
            actorId: input.createdBy,
            reason: input.requestedReason,
            metadata: { createdSource: definition.createdSource },
        });
        return definition;
    }
    async listServers(input) {
        return this.mcpServers.listServers(input);
    }
    async disableServer(input) {
        const server = await this.requireServer(input.appId, input.serverId);
        if (!isMcpServerActive(server)) {
            throw new ApplicationError('INVALID_REQUEST', `Only active MCP servers can be disabled: ${server.id}`);
        }
        const now = nowIso();
        const disabled = {
            ...server,
            status: 'disabled',
            disabledBy: input.disabledBy,
            disabledAt: now,
            updatedAt: now,
        };
        const transitioned = await this.mcpServers.transitionServerStatus({
            appId: input.appId,
            serverId: server.id,
            expectedStatus: 'active',
            next: disabled,
        });
        if (!transitioned) {
            throw new ApplicationError('CONFLICT', `MCP server changed before disable completed: ${server.id}`);
        }
        await this.audit({
            appId: input.appId,
            serverId: server.id,
            eventType: 'disable',
            actorId: input.disabledBy,
            reason: input.reason,
        });
        return transitioned;
    }
    async testServer(input) {
        const server = await this.requireServer(input.appId, input.serverId);
        if (!isMcpServerActive(server)) {
            throw new ApplicationError('INVALID_REQUEST', `MCP server must be active before testing: ${server.id}`);
        }
        validateTransportConfig(server.config, {
            sandboxProfileId: server.sandboxProfileId,
        });
        await assertRemoteMcpDestinationPublic(server.config, this.options.lookupHostname, {
            cache: this.options.dnsValidationCache,
            lookupTimeoutMs: this.options.dnsLookupTimeoutMs,
        });
        assertNoRawSecretsInMcpConfig(server.config);
        validateCredentialRefs(server.credentialRefs);
        await this.audit({
            appId: input.appId,
            serverId: server.id,
            eventType: 'test',
            actorId: input.testedBy,
            metadata: { transport: server.transport },
        });
        return {
            server,
            ok: true,
            message: 'MCP server definition is active and safe to materialize.',
        };
    }
    async bindToAgent(input) {
        await this.assertAgentInApp(input.appId, input.agentId);
        const server = await this.requireServer(input.appId, input.serverId);
        if (!isMcpServerActive(server)) {
            throw new ApplicationError('INVALID_REQUEST', `MCP server must be active before binding: ${server.id}`);
        }
        const existingBinding = (await this.mcpServers.listAgentBindings({
            appId: input.appId,
            agentId: input.agentId,
            limit: 500,
        })).find((binding) => binding.serverId === input.serverId);
        const latestServer = await this.requireServer(input.appId, input.serverId);
        if (!isMcpServerActive(latestServer)) {
            throw new ApplicationError('CONFLICT', `MCP server changed before binding completed: ${input.serverId}`);
        }
        const allowedToolPatterns = normalizeAgentMcpToolScope({
            serverName: latestServer.name,
            requested: input.allowedToolPatterns ?? existingBinding?.allowedToolPatterns,
            definitionPatterns: reviewedMcpToolPatterns(latestServer),
        });
        const now = nowIso();
        const binding = {
            id: `agent-mcp-binding:${input.agentId}:${input.serverId}`,
            appId: input.appId,
            agentId: input.agentId,
            serverId: input.serverId,
            status: 'active',
            required: input.required ?? existingBinding?.required ?? false,
            permissionPolicyIds: input.permissionPolicyIds ?? existingBinding?.permissionPolicyIds ?? [],
            allowedToolPatterns,
            createdAt: existingBinding?.createdAt ?? now,
            updatedAt: now,
        };
        await this.mcpServers.saveAgentBinding(binding);
        await this.audit({
            appId: input.appId,
            agentId: input.agentId,
            serverId: input.serverId,
            bindingId: binding.id,
            eventType: 'bind',
            metadata: {
                permissionPolicyIds: binding.permissionPolicyIds,
                preservedPermissionPolicies: !input.permissionPolicyIds && Boolean(existingBinding),
            },
        });
        return binding;
    }
    async unbindFromAgent(input) {
        await this.assertAgentInApp(input.appId, input.agentId);
        const binding = await this.mcpServers.disableAgentBinding({
            ...input,
            updatedAt: nowIso(),
        });
        if (binding) {
            await this.audit({
                appId: input.appId,
                agentId: input.agentId,
                serverId: input.serverId,
                bindingId: binding.id,
                eventType: 'unbind',
            });
        }
        return binding;
    }
    async rollbackBinding(input) {
        const now = nowIso();
        await this.mcpServers.disableAgentBinding({
            appId: input.appId,
            agentId: input.agentId,
            serverId: input.serverId,
            updatedAt: now,
        });
        await this.audit({
            appId: input.appId,
            agentId: input.agentId,
            serverId: input.serverId,
            eventType: 'unbind',
            reason: 'Rolled back binding after settings sync failure.',
        });
    }
    async rollbackConnectedServer(input) {
        const now = nowIso();
        await this.mcpServers.disableAgentBinding({
            appId: input.appId,
            agentId: input.agentId,
            serverId: input.serverId,
            updatedAt: now,
        });
        const server = await this.mcpServers.getServer(input.serverId);
        if (server && server.appId === input.appId && isMcpServerActive(server)) {
            const disabled = {
                ...server,
                status: 'disabled',
                disabledBy: 'rollback',
                disabledAt: now,
                updatedAt: now,
            };
            await this.mcpServers.transitionServerStatus({
                appId: input.appId,
                serverId: input.serverId,
                expectedStatus: 'active',
                next: disabled,
            });
        }
        await this.audit({
            appId: input.appId,
            agentId: input.agentId,
            serverId: input.serverId,
            eventType: 'disable',
            reason: 'Rolled back MCP server after connect flow failure.',
        });
    }
    async listAgentBindings(input) {
        await this.assertAgentInApp(input.appId, input.agentId);
        return this.mcpServers.listAgentBindings(input);
    }
    async materializeForAgent(input) {
        if (input.serverIds && input.serverIds.length === 0) {
            return [];
        }
        const records = await this.mcpServers.listMaterializedServersForAgent(input);
        const settled = await Promise.allSettled(records.map((record) => this.materializeOne(record, input.credentialEnv ?? {})));
        const capabilities = [];
        for (let index = 0; index < settled.length; index += 1) {
            const result = settled[index];
            const record = records[index];
            if (result.status === 'fulfilled') {
                capabilities.push(result.value);
                continue;
            }
            const reason = result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            await this.audit({
                appId: input.appId,
                agentId: input.agentId,
                serverId: record.definition.id,
                bindingId: record.binding.id,
                eventType: 'startup_failure',
                reason,
                metadata: {
                    name: record.definition.name,
                    required: record.binding.required,
                },
            });
            if (result.reason instanceof ApplicationError &&
                /(?:Missing Gantry Credential|(?:A )?Gantry (?:Credential|capability credential)(?:s)? (?:is |are )?required|required Gantry capability credential is missing)/i.test(result.reason.message)) {
                continue;
            }
            if (record.binding.required) {
                throw new ApplicationError('INVALID_REQUEST', `Required MCP server failed to materialize: ${record.definition.name}: ${reason}`);
            }
        }
        if (this.options.auditMaterialization ?? true) {
            const recordsByName = new Map(records.map((record) => [record.definition.name, record]));
            for (const capability of capabilities) {
                const record = recordsByName.get(capability.name);
                await this.audit({
                    appId: input.appId,
                    agentId: input.agentId,
                    serverId: record?.definition.id,
                    bindingId: record?.binding.id,
                    eventType: 'materialize',
                    metadata: { name: capability.name, required: capability.required },
                });
            }
        }
        return capabilities;
    }
    async materializeOne(record, credentialEnv) {
        await assertRemoteMcpDestinationPublic(record.definition.config, this.options.lookupHostname, {
            cache: this.options.dnsValidationCache,
            lookupTimeoutMs: this.options.dnsLookupTimeoutMs,
        });
        return materializeMcpRecord(record, credentialEnv);
    }
    async requireServer(appId, serverId) {
        const server = await this.mcpServers.getServer(serverId);
        if (!server || server.appId !== appId) {
            throw new ApplicationError('NOT_FOUND', `MCP server not found: ${serverId}`);
        }
        return server;
    }
    async assertAgentInApp(appId, agentId) {
        if (!this.agents)
            return;
        const agent = await this.agents.getAgent(agentId);
        if (!agent || agent.appId !== appId) {
            throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
        }
    }
    async audit(input) {
        await this.mcpServers.appendAuditEvent({
            id: `mcp-audit:${globalThis.crypto.randomUUID()}`,
            metadata: input.metadata ?? {},
            createdAt: nowIso(),
            ...input,
        });
    }
}
const MCP_TOOL_PATTERN = /^[A-Za-z0-9_.-]+(?:\*)?$/;
function validateToolPatternPolicy(input) {
    const allowed = new Set(input.allowedToolPatterns);
    for (const pattern of [
        ...input.allowedToolPatterns,
        ...input.autoApproveToolPatterns,
    ]) {
        if (!MCP_TOOL_PATTERN.test(pattern)) {
            throw new ApplicationError('INVALID_REQUEST', `Invalid MCP tool pattern: ${pattern}`);
        }
    }
    if (allowed.size === 0)
        return;
    for (const pattern of input.autoApproveToolPatterns) {
        if (![...allowed].some((allowedPattern) => toolPatternCovers(allowedPattern, pattern))) {
            throw new ApplicationError('INVALID_REQUEST', `Auto-approved MCP tool must also be listed in allowedToolPatterns: ${pattern}`);
        }
    }
}
function toolPatternCovers(allowedPattern, candidate) {
    if (allowedPattern === candidate)
        return true;
    return allowedPattern.endsWith('*')
        ? candidate.startsWith(allowedPattern.slice(0, -1))
        : false;
}

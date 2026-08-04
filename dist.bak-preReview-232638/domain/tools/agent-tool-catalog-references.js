import { adminMcpToolIdForFullName, isDurableGantryMcpToolFullName, isSeededGantryMcpToolFullName, } from '../../shared/admin-mcp-tools.js';
import { persistentPermissionToolId, parseReadableScopedToolRule, RUN_COMMAND_TOOL_NAME, validateReadableAgentToolRule, } from '../../shared/agent-tool-references.js';
import { containsGeneratedRuntimeSkillPath, GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON, } from '../../shared/generated-runtime-paths.js';
import { formatDurableAccessRulesForUser, validateDurableAccessRule, } from '../../shared/durable-access-policy.js';
import { semanticCapabilityInputSchema, semanticCapabilityFromToolCatalogItem, validateSemanticCapabilityDefinition, } from '../../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule, semanticCapabilityRule, } from '../../shared/semantic-capability-ids.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
export async function ensureAgentToolCatalogItem(input) {
    const reference = input.reference.trim();
    const durableValidation = validateDurableAccessRule(reference, {
        semanticCapabilityDefinitions: input.semanticCapabilityDefinitions,
    });
    if (!durableValidation.ok)
        throw new Error(durableValidation.reason);
    if (isDurableGantryMcpToolFullName(reference)) {
        const toolId = durableGantryCatalogToolId(input.appId, reference);
        const existing = await input.repository.getTool(toolId);
        if (existing) {
            const validated = validateCatalogTool(input.appId, toolId, existing);
            if (validated.tool)
                return validated.tool;
            throw new Error(validated.error);
        }
        const item = {
            id: toolId,
            appId: input.appId,
            name: reference,
            kind: 'host',
            provider: 'gantry',
            displayName: formatDurableAccessRulesForUser([reference]),
            description: input.description ??
                'Persistent Gantry tool approved from settings.yaml.',
            category: 'admin',
            risk: 'high',
            selectable: true,
            status: 'active',
            adapterRef: input.adapterRef ?? 'permission/settings.yaml',
            createdAt: input.now,
            updatedAt: input.now,
        };
        await input.repository.saveTool(item);
        return item;
    }
    const requestedSemanticCapabilityId = parseSemanticCapabilityRule(reference);
    const requestedCapability = requestedSemanticCapabilityId
        ? input.semanticCapabilityDefinitions?.[requestedSemanticCapabilityId]
        : undefined;
    const resolved = await resolveAgentToolReference(input);
    if (requestedSemanticCapabilityId && requestedCapability) {
        if (resolved.tool &&
            catalogToolMatchesSemanticCapability(resolved.tool, requestedCapability)) {
            return resolved.tool;
        }
        return saveSemanticCapabilityTool({
            repository: input.repository,
            appId: input.appId,
            capabilityId: requestedSemanticCapabilityId,
            capability: requestedCapability,
            now: input.now,
        });
    }
    if (resolved.tool)
        return resolved.tool;
    if (resolved.error &&
        !(requestedSemanticCapabilityId &&
            input.semanticCapabilityDefinitions?.[requestedSemanticCapabilityId])) {
        throw new Error(resolved.error);
    }
    const allowedRule = reference;
    const validation = validateReadableAgentToolRule(allowedRule);
    if (!validation.ok)
        throw new Error(validation.reason);
    const semanticCapabilityId = parseSemanticCapabilityRule(allowedRule);
    if (semanticCapabilityId) {
        const capability = input.semanticCapabilityDefinitions?.[semanticCapabilityId];
        if (!capability) {
            throw new Error(`Unknown semantic capability ${semanticCapabilityId}. Review and register a user-defined capability before selecting it.`);
        }
        return saveSemanticCapabilityTool({
            repository: input.repository,
            appId: input.appId,
            capabilityId: semanticCapabilityId,
            capability,
            now: input.now,
        });
    }
    const scoped = parseReadableScopedToolRule(allowedRule);
    if (!scoped || scoped.toolName !== RUN_COMMAND_TOOL_NAME) {
        throw new Error(`Unknown tool capability ${allowedRule}. Select a catalog tool, semantic capability, or scoped RunCommand(...) rule.`);
    }
    const item = {
        id: persistentPermissionToolId(input.appId, allowedRule),
        appId: input.appId,
        name: allowedRule,
        kind: 'host',
        provider: 'gantry',
        displayName: allowedRule,
        description: input.description ??
            'Persistent permission tool approved from settings.yaml.',
        category: 'admin',
        risk: 'high',
        selectable: true,
        status: 'active',
        adapterRef: input.adapterRef ?? 'permission/settings.yaml',
        createdAt: input.now,
        updatedAt: input.now,
    };
    await input.repository.saveTool(item);
    return item;
}
async function saveSemanticCapabilityTool(input) {
    const capabilityValidation = validateSemanticCapabilityDefinition(input.capability);
    if (!capabilityValidation.ok) {
        throw new Error(capabilityValidation.reason);
    }
    const item = {
        id: `tool:capability:${input.capabilityId}`,
        appId: input.appId,
        name: semanticCapabilityRule(input.capabilityId),
        kind: input.capability.credentialSource === 'local_cli' ? 'local_cli' : 'host',
        provider: input.capability.credentialSource === 'local_cli'
            ? 'local_cli'
            : 'gantry',
        displayName: input.capability.displayName,
        description: `${input.capability.can} Cannot: ${input.capability.cannot}`,
        category: 'productivity',
        risk: input.capability.risk === 'read' ? 'low' : 'high',
        selectable: true,
        status: 'active',
        inputSchema: semanticCapabilityInputSchema(input.capability),
        adapterRef: `capability/${input.capabilityId}`,
        createdAt: input.now,
        updatedAt: input.now,
    };
    await input.repository.saveTool(item);
    return item;
}
export async function resolveAgentToolReference(input) {
    const reference = input.reference.trim();
    if (!reference)
        return { error: 'Tool rule cannot be empty.' };
    if (reference.startsWith('tool:')) {
        return {
            error: 'Tool rule must be readable; use a tool name or scoped RunCommand rule, not an internal tool ID.',
        };
    }
    if (containsGeneratedRuntimeSkillPath(reference)) {
        return { error: GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON };
    }
    const activeTools = await input.repository.listTools({
        appId: input.appId,
        statuses: ['active'],
    });
    const byName = activeTools.find((tool) => tool.selectable && tool.name === reference);
    if (byName)
        return validateCatalogTool(input.appId, byName.id, byName);
    if (isDurableGantryMcpToolFullName(reference)) {
        const toolId = durableGantryCatalogToolId(input.appId, reference);
        const tool = await input.repository.getTool(toolId);
        if (tool) {
            return validateCatalogTool(input.appId, toolId, tool);
        }
        return {};
    }
    const validation = validateReadableAgentToolRule(reference);
    if (!validation.ok)
        return { error: validation.reason };
    const semanticCapabilityId = parseSemanticCapabilityRule(reference);
    if (semanticCapabilityId) {
        if (input.semanticCapabilityDefinitions?.[semanticCapabilityId]) {
            return {};
        }
        return {
            error: `Unknown semantic capability ${semanticCapabilityId}. Review and register a user-defined capability before selecting it.`,
        };
    }
    const scoped = parseReadableScopedToolRule(reference);
    if (scoped?.toolName === RUN_COMMAND_TOOL_NAME)
        return {};
    if (reference.startsWith('mcp__')) {
        return {
            error: 'Third-party MCP tool names are not selected directly; connect the MCP source and request a reviewed semantic capability for the exact action.',
        };
    }
    return {
        error: `Unknown tool capability ${reference}. Select a catalog tool, semantic capability, or scoped RunCommand(...) rule.`,
    };
}
function validateCatalogTool(appId, reference, tool) {
    if (tool.appId !== appId || tool.status !== 'active' || !tool.selectable) {
        return { error: `Tool catalog row ${reference} is unavailable.` };
    }
    return { tool };
}
function durableGantryCatalogToolId(appId, reference) {
    return (isSeededGantryMcpToolFullName(reference)
        ? adminMcpToolIdForFullName(reference)
        : persistentPermissionToolId(appId, reference));
}
function catalogToolMatchesSemanticCapability(tool, capability) {
    const existing = semanticCapabilityFromToolCatalogItem({
        name: tool.name,
        inputSchema: tool.inputSchema,
    });
    return (!!existing &&
        existing.capabilityId === capability.capabilityId &&
        stableSha256Json(existing) === stableSha256Json(capability));
}

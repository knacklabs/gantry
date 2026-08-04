import { skillActionSource } from '../../domain/skills/skill-action-permissions.js';
import { isGantryMcpWildcardRule } from '../../shared/admin-mcp-tools.js';
import { BROWSER_ACTION_MCP_RULE_REJECTION_REASON, BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON, isBrowserActionMcpToolRule, isProjectedBrowserMcpToolRule, isReviewedMcpPatternRule, isThirdPartyMcpToolRule, validateReadableAgentToolRule, } from '../../shared/agent-tool-references.js';
import { mcpPatternBindingRuntimeRules, projectToolCatalogItemToRuntimeRules, semanticCapabilityFromToolCatalogItem, } from '../../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
export function reviewedMcpReadBindingsForRuntimeAccess(input) {
    const readCapabilities = new Map((input.semanticCapabilities ?? [])
        .filter((capability) => capability.risk === 'read')
        .map((capability) => [capability.capabilityId, capability]));
    const bindings = new Map();
    for (const access of input.runtimeAccess ?? []) {
        if (access.sourceType !== 'mcp_server')
            continue;
        const capability = readCapabilities.get(access.selectedCapabilityId);
        if (!capability)
            continue;
        const reviewedPatterns = new Set(capability.implementationBindings.flatMap((binding) => mcpPatternBindingRuntimeRules(binding)));
        for (const toolPattern of access.allowedTools) {
            if (!reviewedPatterns.has(toolPattern))
                continue;
            bindings.set(`${capability.capabilityId}\0${toolPattern}`, {
                capabilityId: capability.capabilityId,
                toolPattern,
            });
        }
    }
    return [...bindings.values()];
}
export async function resolveAgentToolRuntimeRules(input) {
    return (await resolveAgentToolRuntimePolicy(input)).rules;
}
export async function resolveAgentToolRuntimePolicy(input) {
    const bindings = await input.repository.listAgentToolBindings({
        appId: input.appId,
        agentId: input.agentId,
    });
    const activeBindings = bindings.filter((binding) => binding.status === 'active');
    const tools = await Promise.all(activeBindings.map((binding) => input.repository.getTool(binding.toolId)));
    const activeSkillActionKeys = await activeSkillActionProjectionKeys(input);
    const runtimeAccess = [];
    const semanticCapabilities = [];
    const rules = tools.flatMap((tool) => {
        if (tool?.appId && tool.appId !== input.appId)
            return [];
        const name = tool?.name?.trim();
        const capability = semanticCapabilityFromToolCatalogItem({
            name,
            inputSchema: tool?.inputSchema,
        });
        if (name && parseSemanticCapabilityRule(name) && !capability) {
            throw input.makeError
                ? input.makeError(`${input.errorSubject} ${name} is invalid. Semantic capability rules must resolve to a reviewed capability definition.`)
                : new Error(`${input.errorSubject} ${name} is invalid. Semantic capability rules must resolve to a reviewed capability definition.`);
        }
        if (name && isThirdPartyMcpToolRule(name) && !capability) {
            throw input.makeError
                ? input.makeError(`${input.errorSubject} ${name} is invalid. Third-party MCP tools must be projected from a reviewed semantic capability.`)
                : new Error(`${input.errorSubject} ${name} is invalid. Third-party MCP tools must be projected from a reviewed semantic capability.`);
        }
        if (capability &&
            !canProjectSemanticCapability(capability, activeSkillActionKeys)) {
            return [];
        }
        if (capability) {
            semanticCapabilities.push(capability);
            runtimeAccess.push(...projectCapabilityRuntimeAccess(capability));
        }
        return name
            ? projectToolCatalogItemToRuntimeRules({
                name,
                inputSchema: tool?.inputSchema,
            })
            : [];
    });
    validateAgentToolRuntimeRules({
        rules,
        errorSubject: input.errorSubject,
        allowProjectedThirdPartyMcpTools: true,
        makeError: input.makeError,
    });
    return {
        rules,
        runtimeAccess,
        semanticCapabilities,
        reviewedMcpReadBindings: reviewedMcpReadBindingsForRuntimeAccess({
            runtimeAccess,
            semanticCapabilities,
        }),
    };
}
function projectCapabilityRuntimeAccess(capability) {
    const source = skillActionSource(capability);
    const common = {
        selectedCapabilityId: capability.capabilityId,
        auditLabel: capability.displayName || capability.capabilityId,
    };
    const commandRules = commandRulesFromCapability(capability);
    if (source) {
        const hosts = normalizedHosts(capability.networkHosts);
        return [
            {
                ...common,
                sourceType: 'skill_action',
                skillId: source.skillId,
                selectedAction: source.actionId,
                declaredEnvRefs: stringList(capability.redactionPolicy?.env),
                commandRules,
                networkBindings: commandRules.length > 0 ? [{ commandRules, hosts }] : [],
            },
        ];
    }
    const access = [];
    const localCliCommandRules = localCliCommandRulesFromCapability(capability);
    if (capability.credentialSource === 'local_cli' &&
        localCliCommandRules.length > 0) {
        const hosts = normalizedHosts(capability.networkHosts);
        access.push({
            ...common,
            sourceType: 'local_cli',
            commandRules: localCliCommandRules,
            credentialDirs: credentialDirectoryHintsFromProtectedPaths(capability.protectedPaths),
            networkBindings: localCliCommandRules.length > 0
                ? [{ commandRules: localCliCommandRules, hosts }]
                : [],
        });
    }
    for (const binding of capability.implementationBindings) {
        if (binding.kind === 'adapter' && binding.adapterRef?.trim()) {
            access.push({
                ...common,
                sourceType: 'configured_adapter',
                adapterRef: binding.adapterRef.trim(),
            });
            continue;
        }
        if (binding.kind === 'mcp_pattern') {
            const patternRules = mcpPatternBindingRuntimeRules(binding);
            if (patternRules.length > 0) {
                access.push({
                    ...common,
                    sourceType: 'mcp_server',
                    reviewedServerId: binding.mcpServer?.trim() ?? 'unknown',
                    allowedTools: patternRules,
                    credentialRefs: [],
                    networkHosts: [],
                });
            }
            continue;
        }
        if (binding.kind === 'tool_rule' && binding.rule?.trim()) {
            access.push({
                ...common,
                sourceType: 'builtin_tool',
                runtimeToolRules: [binding.rule.trim()],
            });
        }
    }
    return access;
}
function commandRulesFromCapability(capability) {
    const out = new Set();
    for (const binding of capability.implementationBindings) {
        if (binding.kind === 'tool_rule' && binding.rule?.trim()) {
            out.add(binding.rule.trim());
        }
        if (binding.kind === 'local_cli') {
            if (capability.credentialSource !== 'local_cli')
                continue;
            for (const rule of commandRulesFromTemplates(binding.commandTemplates)) {
                out.add(rule);
            }
        }
    }
    return [...out];
}
function localCliCommandRulesFromCapability(capability) {
    const out = new Set();
    for (const binding of capability.implementationBindings) {
        if (capability.credentialSource !== 'local_cli')
            continue;
        if (binding.kind !== 'local_cli')
            continue;
        for (const rule of commandRulesFromTemplates(binding.commandTemplates)) {
            out.add(rule);
        }
    }
    return [...out];
}
function commandRulesFromTemplates(templates) {
    return stringList(templates).map((template) => `RunCommand(${template})`);
}
function normalizedHosts(values) {
    return stringList(values).map((host) => host.toLowerCase());
}
function credentialDirectoryHintsFromProtectedPaths(values) {
    const out = new Set();
    for (const value of stringList(values)) {
        const directory = credentialDirectoryHintFromProtectedPath(value);
        if (directory)
            out.add(directory);
    }
    return [...out];
}
function credentialDirectoryHintFromProtectedPath(protectedPath) {
    let value = protectedPath.trim();
    while (pathHintLeaf(value)?.includes('*')) {
        const parent = parentPathHint(value);
        if (!parent)
            return undefined;
        value = parent;
    }
    value = stripTrailingPathSeparator(value);
    if (!value || value.includes('*'))
        return undefined;
    const leaf = pathHintLeaf(value);
    if (!leaf)
        return undefined;
    if (looksLikeFilePathHint(leaf)) {
        return parentPathHint(value);
    }
    return value;
}
function stripTrailingPathSeparator(value) {
    return value.replace(/[/\\]+$/, '');
}
function pathHintLeaf(value) {
    return value.split(/[/\\]/).filter(Boolean).pop();
}
function looksLikeFilePathHint(leaf) {
    if (leaf.startsWith('.'))
        return false;
    return /^[^/\\]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(leaf);
}
function parentPathHint(value) {
    const separatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    if (separatorIndex === 0 && value.startsWith('/'))
        return '/';
    if (separatorIndex <= 0)
        return undefined;
    const parent = stripTrailingPathSeparator(value.slice(0, separatorIndex));
    return parent || undefined;
}
function stringList(values) {
    if (!values)
        return [];
    const out = new Set();
    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed)
            out.add(trimmed);
    }
    return [...out];
}
async function activeSkillActionProjectionKeys(input) {
    if (!input.skillRepository)
        return undefined;
    if (!('listEnabledSkillsForAgent' in input.skillRepository)) {
        return undefined;
    }
    const skills = await input.skillRepository.listEnabledSkillsForAgent({
        appId: input.appId,
        agentId: input.agentId,
    });
    return new Set(skills.flatMap((skill) => (skill.actionPermissions ?? []).map((action) => skillActionProjectionKey({
        skillId: String(skill.id),
        actionId: action.id,
    }))));
}
function canProjectSemanticCapability(capability, activeSkillActionKeys) {
    const source = skillActionSource(capability);
    if (!source)
        return true;
    if (!activeSkillActionKeys)
        return false;
    return activeSkillActionKeys.has(skillActionProjectionKey({
        skillId: source.skillId,
        actionId: source.actionId,
    }));
}
function skillActionProjectionKey(input) {
    return `${input.skillId}\0${input.actionId}`;
}
export function validateAgentToolRuntimeRules(input) {
    const fail = (rule, reason) => {
        const message = `${input.errorSubject} ${rule} is invalid. ${reason}`;
        throw input.makeError ? input.makeError(message) : new Error(message);
    };
    const staleBrowserRule = input.rules.find(isBrowserActionMcpToolRule);
    if (staleBrowserRule) {
        fail(staleBrowserRule, BROWSER_ACTION_MCP_RULE_REJECTION_REASON);
    }
    const projectedBrowserRule = input.rules.find(isProjectedBrowserMcpToolRule);
    if (projectedBrowserRule) {
        fail(projectedBrowserRule, BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON);
    }
    const gantryWildcardRule = input.rules.find(isGantryMcpWildcardRule);
    if (gantryWildcardRule) {
        fail(gantryWildcardRule, 'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.');
    }
    const thirdPartyMcpToolRule = input.rules.find(isThirdPartyMcpToolRule);
    if (thirdPartyMcpToolRule && !input.allowProjectedThirdPartyMcpTools) {
        fail(thirdPartyMcpToolRule, 'Third-party MCP tool names must be projected from a reviewed semantic capability.');
    }
    for (const rule of input.rules) {
        // Reviewed MCP pattern rules are projections from a reviewed mcp_pattern
        // capability binding; they are valid at projection time only and stay
        // rejected as durable raw grants by validateReadableAgentToolRule.
        if (input.allowProjectedThirdPartyMcpTools &&
            isReviewedMcpPatternRule(rule))
            continue;
        const validation = validateReadableAgentToolRule(rule);
        if (!validation.ok) {
            fail(rule, validation.reason);
        }
    }
}

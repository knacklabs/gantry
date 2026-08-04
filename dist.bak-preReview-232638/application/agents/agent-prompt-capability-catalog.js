import { isSkillUsableForBinding } from '../../domain/skills/skills.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { humanizeTechnicalIdentifier } from '../../shared/user-visible-messages.js';
const DISPLAY_NAME_LIMIT = 96;
const DESCRIPTION_LIMIT = 160;
const CATEGORY_LIMIT = 64;
const ACCOUNT_LABEL_LIMIT = 96;
export async function resolveAgentPromptCapabilityCatalog(input) {
    const skillRepository = repositoryValue(input.skillRepository);
    const mcpServerRepository = repositoryValue(input.mcpServerRepository);
    const [readyActions, installedSkills, connectedMcpSources] = await Promise.all([
        resolveReadyActions(input.readySemanticCapabilities),
        resolveInstalledSkills(input, skillRepository),
        resolveConnectedMcpSources(input, mcpServerRepository),
    ]);
    const projection = {
        schemaVersion: 1,
        readyActions: sortEntries(readyActions),
        installedSkills: sortEntries(installedSkills),
        connectedMcpSources: sortEntries(connectedMcpSources),
    };
    return { ...projection, digest: stableSha256Json(projection) };
}
function resolveReadyActions(capabilities) {
    const actions = (capabilities ?? []).map((capability) => {
        const revision = normalizedRevision(capability.version);
        const accountLabel = normalizedOptional(capability.accountLabel, ACCOUNT_LABEL_LIMIT);
        return {
            kind: 'reviewed_capability',
            stableRef: capability.capabilityId,
            ...(revision ? { revision } : {}),
            displayName: normalizedText(capability.displayName, humanizeTechnicalIdentifier(capability.capabilityId), DISPLAY_NAME_LIMIT),
            description: normalizedText(capability.can, 'Reviewed action available to this agent.', DESCRIPTION_LIMIT),
            category: normalizedText(capability.category, 'actions', CATEGORY_LIMIT),
            ...(accountLabel ? { accountLabel } : {}),
        };
    });
    const uniqueActions = dedupeEntries(actions);
    const nameCounts = new Map();
    for (const action of uniqueActions) {
        const key = action.displayName.toLowerCase();
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    return uniqueActions.map((action) => nameCounts.get(action.displayName.toLowerCase()) === 1
        ? withoutAccountLabel(action)
        : action);
}
async function resolveInstalledSkills(input, repository) {
    if (!repository)
        return [];
    const bindings = await repository.listAgentSkillBindings({
        appId: input.appId,
        agentId: input.agentId,
    });
    const skills = await Promise.all(bindings
        .filter((binding) => binding.status === 'active' &&
        binding.appId === input.appId &&
        binding.agentId === input.agentId)
        .map((binding) => repository.getSkill(binding.skillId)));
    return dedupeEntries(skills.flatMap((skill) => {
        if (!skill ||
            skill.appId !== input.appId ||
            (skill.agentId && skill.agentId !== input.agentId) ||
            !isSkillUsableForBinding(skill)) {
            return [];
        }
        const revision = normalizedRevision(skill.storage?.contentHash ?? skill.updatedAt);
        return [
            {
                kind: 'skill',
                stableRef: String(skill.id),
                ...(revision ? { revision } : {}),
                displayName: normalizedText(skill.name, humanizeTechnicalIdentifier(String(skill.id)), DISPLAY_NAME_LIMIT),
                description: normalizedText(skill.description, 'Installed skill instructions.', DESCRIPTION_LIMIT),
                category: 'skills',
            },
        ];
    }));
}
async function resolveConnectedMcpSources(input, repository) {
    if (!repository)
        return [];
    const bindings = await repository.listAgentBindings({
        appId: input.appId,
        agentId: input.agentId,
        limit: 500,
    });
    const servers = await Promise.all(bindings
        .filter((binding) => binding.status === 'active' &&
        binding.appId === input.appId &&
        binding.agentId === input.agentId)
        .map((binding) => repository.getServer(binding.serverId)));
    return dedupeEntries(servers.flatMap((server) => {
        if (!server ||
            server.appId !== input.appId ||
            server.status !== 'active') {
            return [];
        }
        const revision = normalizedRevision(server.updatedAt);
        return [
            {
                kind: 'mcp_source',
                stableRef: String(server.id),
                ...(revision ? { revision } : {}),
                displayName: normalizedText(server.displayName ?? server.name, humanizeTechnicalIdentifier(server.name), DISPLAY_NAME_LIMIT),
                description: normalizedText(server.description, 'Connected MCP source inventory.', DESCRIPTION_LIMIT),
                category: 'mcp',
            },
        ];
    }));
}
function repositoryValue(input) {
    return typeof input === 'function' ? input() : input;
}
function normalizedText(value, fallback, limit) {
    return boundOneLine(value) || boundOneLine(fallback).slice(0, limit);
    function boundOneLine(candidate) {
        const normalized = candidate?.replace(/\s+/g, ' ').trim() ?? '';
        if (normalized.length <= limit)
            return normalized;
        return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
    }
}
function normalizedOptional(value, limit = DESCRIPTION_LIMIT) {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized)
        return undefined;
    if (normalized.length <= limit)
        return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function normalizedRevision(value) {
    return value?.trim() || undefined;
}
function withoutAccountLabel(entry) {
    const { accountLabel: _accountLabel, ...rest } = entry;
    return rest;
}
function dedupeEntries(entries) {
    return [
        ...new Map(entries.map((entry) => [entry.stableRef, entry])).values(),
    ];
}
function sortEntries(entries) {
    return [...entries].sort(compareCatalogEntries);
}
export function compareCatalogEntries(left, right) {
    for (const [leftValue, rightValue] of [
        [left.category, right.category],
        [left.displayName, right.displayName],
        [left.stableRef, right.stableRef],
    ]) {
        const order = compareText(leftValue, rightValue);
        if (order !== 0)
            return order;
    }
    return 0;
}
function compareText(left, right) {
    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    return normalizedLeft < normalizedRight
        ? -1
        : normalizedLeft > normalizedRight
            ? 1
            : left < right
                ? -1
                : left > right
                    ? 1
                    : 0;
}

import { isValidWorkspaceFolder } from '../../platform/workspace-folder-rules.js';
export const DEFAULT_CONTROL_ALLOWLIST = {
    default: [],
    agents: {},
};
export function createDefaultControlAllowlist() {
    return {
        default: [...DEFAULT_CONTROL_ALLOWLIST.default],
        agents: {},
    };
}
function parseStringList(raw, pathPrefix) {
    if (!Array.isArray(raw)) {
        throw new Error(`${pathPrefix} must be a string list`);
    }
    const values = raw.map((item) => {
        if (typeof item !== 'string' || !item.trim()) {
            throw new Error(`${pathPrefix} must contain only non-empty strings`);
        }
        return item.trim();
    });
    return [...new Set(values)];
}
export function parseSenderControlAllowlistConfig(raw, pathPrefix) {
    if (raw === undefined)
        return createDefaultControlAllowlist();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = raw;
    const agentsRaw = map.agents;
    if (typeof agentsRaw !== 'object' ||
        agentsRaw === null ||
        Array.isArray(agentsRaw)) {
        throw new Error(`${pathPrefix}.agents must be a mapping`);
    }
    const agents = {};
    for (const [folder, rawList] of Object.entries(agentsRaw)) {
        const trimmedFolder = folder.trim();
        if (!trimmedFolder)
            throw new Error(`${pathPrefix}.agents has empty key`);
        if (!isValidWorkspaceFolder(trimmedFolder)) {
            throw new Error(`${pathPrefix}.agents.${trimmedFolder} must use a valid agent folder key`);
        }
        agents[trimmedFolder] = parseStringList(rawList, `${pathPrefix}.agents.${trimmedFolder}`);
    }
    return {
        default: parseStringList(map.default ?? [], `${pathPrefix}.default`),
        agents,
    };
}
export function renderControlAllowlistYaml(lines, indent, quoteYamlKey, config) {
    lines.push(`${indent}default: ${JSON.stringify(config.default)}`);
    lines.push(`${indent}agents:`);
    const entries = Object.entries(config.agents).sort(([a], [b]) => a.localeCompare(b));
    for (const [folder, senders] of entries) {
        lines.push(`${indent}  ${quoteYamlKey(folder)}: ${JSON.stringify(senders)}`);
    }
}
export function addControlSenderForAgent(channel, folder, sender) {
    const trimmedFolder = folder.trim();
    const trimmedSender = sender.trim();
    if (!isValidWorkspaceFolder(trimmedFolder)) {
        throw new Error(`Invalid agent folder for control allowlist: ${folder}`);
    }
    if (!trimmedSender)
        return false;
    const existing = channel.controlAllowlist.agents[trimmedFolder] || [];
    const next = [...new Set([...existing, trimmedSender])];
    channel.controlAllowlist.agents[trimmedFolder] = next;
    return next.length !== existing.length;
}

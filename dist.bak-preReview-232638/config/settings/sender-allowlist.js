import { isValidWorkspaceFolder } from '../../platform/workspace-folder-rules.js';
const DEFAULT_SENDER_ALLOWLIST = {
    default: { allow: '*', mode: 'trigger' },
    agents: {},
    logDenied: true,
};
export function createDefaultSenderAllowlist() {
    return {
        default: { ...DEFAULT_SENDER_ALLOWLIST.default },
        agents: {},
        logDenied: DEFAULT_SENDER_ALLOWLIST.logDenied,
    };
}
function isValidAllowlistEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return false;
    const row = entry;
    const allow = row.allow;
    const mode = row.mode;
    const validAllow = allow === '*' ||
        (Array.isArray(allow) &&
            allow.every((item) => typeof item === 'string' && item.trim()));
    const validMode = mode === 'trigger' || mode === 'drop';
    return validAllow && validMode;
}
function normalizeAllowlistEntry(entry) {
    return {
        allow: entry.allow === '*' ? '*' : entry.allow.map((value) => value.trim()),
        mode: entry.mode,
    };
}
export function parseSenderAllowlistConfig(raw, pathPrefix) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = raw;
    if (!isValidAllowlistEntry(map.default)) {
        throw new Error(`${pathPrefix}.default must include allow and mode`);
    }
    const agentsRaw = map.agents;
    if (typeof agentsRaw !== 'object' ||
        agentsRaw === null ||
        Array.isArray(agentsRaw)) {
        throw new Error(`${pathPrefix}.agents must be a mapping`);
    }
    const agents = {};
    for (const [folder, entry] of Object.entries(agentsRaw)) {
        const trimmedFolder = folder.trim();
        if (!trimmedFolder)
            throw new Error(`${pathPrefix}.agents has empty key`);
        if (!isValidWorkspaceFolder(trimmedFolder)) {
            throw new Error(`${pathPrefix}.agents.${trimmedFolder} must use a valid agent folder key`);
        }
        if (!isValidAllowlistEntry(entry)) {
            throw new Error(`${pathPrefix}.agents.${trimmedFolder} is invalid`);
        }
        agents[trimmedFolder] = normalizeAllowlistEntry(entry);
    }
    if (typeof map.log_denied !== 'boolean') {
        throw new Error(`${pathPrefix}.log_denied must be true/false`);
    }
    return {
        default: normalizeAllowlistEntry(map.default),
        agents,
        logDenied: map.log_denied,
    };
}
function renderAllowValue(allow) {
    if (allow === '*')
        return '"*"';
    return JSON.stringify(allow);
}
export function renderSenderAllowlistYaml(lines, indent, quoteYamlKey, config) {
    lines.push(`${indent}default:`);
    lines.push(`${indent}  allow: ${renderAllowValue(config.default.allow)}`);
    lines.push(`${indent}  mode: ${config.default.mode}`);
    lines.push(`${indent}agents:`);
    const entries = Object.entries(config.agents).sort(([a], [b]) => a.localeCompare(b));
    for (const [folder, entry] of entries) {
        lines.push(`${indent}  ${quoteYamlKey(folder)}:`);
        lines.push(`${indent}    allow: ${renderAllowValue(entry.allow)}`);
        lines.push(`${indent}    mode: ${entry.mode}`);
    }
    lines.push(`${indent}log_denied: ${config.logDenied ? 'true' : 'false'}`);
}

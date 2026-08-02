import fs from 'fs';
import path from 'path';
import { DEFAULT_AGENT_NAME } from '../shared/default-agent.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
export { defaultTriggerForAgentName } from '../shared/trigger-pattern.js';
export const DEFAULT_AGENT_CLI_NAME = DEFAULT_AGENT_NAME;
export const DEFAULT_AGENT_FOLDER = 'main_agent';
/**
 * True when `folder` is the default agent and the given routes contain only one
 * route for it. The runtime re-seeds a default agent route whenever no routes
 * remain (ensureFreshRuntimeHasDefaultAgent), so removing the default agent's
 * last route can silently return on the next boot -- callers should refuse it.
 */
export function isDefaultAgentLastRoute(groups, folder) {
    if (folder !== DEFAULT_AGENT_FOLDER)
        return false;
    return (Object.values(groups).filter((group) => group.folder === DEFAULT_AGENT_FOLDER).length <= 1);
}
export function normalizeDefaultAgentName(raw) {
    return raw?.trim() || DEFAULT_AGENT_CLI_NAME;
}
export function defaultAgentNameFromSettings(settings) {
    return normalizeDefaultAgentName(settings.agent.name);
}
export function allocateDefaultAgentFolder(runtimeHome, existing) {
    const hasSeededDefaultPlaceholder = Object.entries(existing).some(([jid, group]) => isSeededDefaultPlaceholderRoute(jid, group));
    const used = new Set(Object.entries(existing)
        .filter(([jid, group]) => !isSeededDefaultPlaceholderRoute(jid, group))
        .map(([, group]) => group.folder));
    const hasOnDiskFolder = (folder) => fs.existsSync(path.join(runtimeHome, 'agents', folder));
    if (!used.has(DEFAULT_AGENT_FOLDER) &&
        (!hasOnDiskFolder(DEFAULT_AGENT_FOLDER) || hasSeededDefaultPlaceholder)) {
        return DEFAULT_AGENT_FOLDER;
    }
    for (let i = 2; i < 1000; i += 1) {
        const candidate = `${DEFAULT_AGENT_FOLDER}_${i}`;
        if (!used.has(candidate) && !hasOnDiskFolder(candidate))
            return candidate;
    }
    return `${DEFAULT_AGENT_FOLDER}_${currentTimeMs()}`;
}
function isSeededDefaultPlaceholderRoute(jid, group) {
    return jid === 'app:default' && group.folder === DEFAULT_AGENT_FOLDER;
}
export function displayAgentName(group, configuredDefaultAgentName) {
    void configuredDefaultAgentName;
    return group.name;
}

import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
export function resolveIpcFoldersFromGroups(groupRegistry) {
    return Array.from(new Set(Object.values(groupRegistry)
        .map((group) => group.folder)
        .filter((folder) => isValidWorkspaceFolder(folder))));
}
export function resolveIpcTargetJidForSourceGroup(groupRegistry, sourceAgentFolder) {
    for (const [jid, group] of Object.entries(groupRegistry)) {
        if (group.folder === sourceAgentFolder)
            return jid;
    }
    return undefined;
}

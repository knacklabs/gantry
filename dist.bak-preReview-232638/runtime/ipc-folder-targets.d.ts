import type { ConversationRoute } from '../domain/types.js';
export declare function buildIpcFolderTargets(groupRegistry: Record<string, ConversationRoute>): {
    folderTargetJid: Map<string, string>;
    folderTargetJids: Map<string, Set<string>>;
};

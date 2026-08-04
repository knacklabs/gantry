import { ConversationRoute, ThinkingOverride } from '../domain/types.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import { AvailableGroup } from './agent-spawn.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
interface ChatRow {
    jid: string;
    name: string | null;
    last_message_time: string;
    is_group: boolean | number;
}
interface RegisterGroupOptions {
    assistantName?: string;
    persist: (jid: string, group: ConversationRoute) => void | Promise<void>;
    ensureCredentialBinding: (jid: string, group: ConversationRoute) => void;
    getFileArtifactStore?: () => FileArtifactStore | undefined;
}
interface EnsureRouteProfileDefaultsOptions {
    assistantName?: string;
    getFileArtifactStore?: () => FileArtifactStore | undefined;
}
export declare function ensureRouteProfileDefaults(routes: Iterable<ConversationRoute>, options?: EnsureRouteProfileDefaultsOptions): Promise<number>;
export declare function registerGroup(conversationRoutes: Record<string, ConversationRoute>, jid: string, group: ConversationRoute, options: RegisterGroupOptions): Promise<void>;
export declare function setGroupModelOverride(conversationRoutes: Record<string, ConversationRoute>, chatJid: string, model: string | undefined, persist: (jid: string, group: ConversationRoute) => void | Promise<void>): Promise<void> | void;
export declare function setGroupThinkingOverride(conversationRoutes: Record<string, ConversationRoute>, chatJid: string, thinking: ThinkingOverride | undefined, persist: (jid: string, group: ConversationRoute) => void | Promise<void>): Promise<void> | void;
export declare function setGroupPermissionModeOverride(conversationRoutes: Record<string, ConversationRoute>, chatJid: string, permissionMode: PermissionMode | undefined, persist: (jid: string, group: ConversationRoute) => void | Promise<void>): Promise<void> | void;
export declare function listAvailableGroups(chats: ChatRow[], conversationRoutes: Record<string, ConversationRoute>): AvailableGroup[];
export {};

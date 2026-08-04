import { NewMessage, ConversationRoute } from '../domain/types.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
export interface RuntimeGroupDb {
    countConversationRoutesByJidPrefix(jidPrefix: string): Promise<number>;
    getAllConversationRoutes(): Promise<Record<string, ConversationRoute>>;
    getMessagesSince(chatJid: string, sinceCursor: string, limit?: number): Promise<NewMessage[]>;
    setConversationRoute(jid: string, group: ConversationRoute): Promise<void>;
    deleteConversationRoute(jid: string): Promise<void>;
    deleteSession(workspaceFolder: string): Promise<void>;
    getFileArtifactStore(): FileArtifactStore;
    getRuntimeSecrets?(): RuntimeSecretProvider;
    close(): Promise<void>;
}
export declare function openRuntimeGroupDb(runtimeHome: string): Promise<RuntimeGroupDb>;

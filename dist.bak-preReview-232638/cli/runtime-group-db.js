import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { createStorageRuntime } from '../adapters/storage/postgres/factory.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
function resolveStorageConfig(runtimeHome) {
    const settings = ensureRuntimeSettings(runtimeHome);
    const env = readEnvFile(envFilePath(runtimeHome));
    const postgresUrlEnv = settings.storage.postgres.urlEnv;
    return {
        postgresUrl: env[postgresUrlEnv]?.trim() ||
            process.env[postgresUrlEnv]?.trim() ||
            null,
        postgresUrlEnv,
        postgresSchema: settings.storage.postgres.schema,
    };
}
function normalizePrefix(jidPrefix) {
    return jidPrefix.endsWith('%') ? jidPrefix.slice(0, -1) : jidPrefix;
}
function createProviderRuntimeGroupDb(runtime) {
    return {
        async countConversationRoutesByJidPrefix(jidPrefix) {
            const prefix = normalizePrefix(jidPrefix);
            const groups = await runtime.ops.getAllConversationRoutes();
            return Object.keys(groups).filter((jid) => jid.startsWith(prefix)).length;
        },
        async getAllConversationRoutes() {
            return runtime.ops.getAllConversationRoutes();
        },
        async getMessagesSince(chatJid, sinceCursor, limit) {
            return runtime.ops.getMessagesSince(chatJid, sinceCursor, limit);
        },
        async setConversationRoute(jid, group) {
            if (!isValidWorkspaceFolder(group.folder)) {
                throw new Error(`Invalid workspace folder "${group.folder}" for JID ${jid}`);
            }
            await runtime.ops.setConversationRoute(jid, group);
        },
        async deleteConversationRoute(jid) {
            await runtime.ops.deleteConversationRoute(jid);
        },
        async deleteSession(workspaceFolder) {
            await runtime.ops.deleteSessionsByAgentFolder(workspaceFolder);
        },
        getFileArtifactStore() {
            return runtime.fileArtifacts;
        },
        getRuntimeSecrets() {
            return createRepositoryRuntimeSecretProvider({
                appId: 'default',
                repository: runtime.repositories.capabilitySecrets,
            });
        },
        async close() {
            await runtime.service.close();
        },
    };
}
export async function openRuntimeGroupDb(runtimeHome) {
    const config = resolveStorageConfig(runtimeHome);
    const runtime = createStorageRuntime(config);
    await runtime.service.assertMigrationsCurrent();
    return createProviderRuntimeGroupDb(runtime);
}

import { NewMessage, ConversationRoute } from '../domain/types.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { createStorageRuntime } from '../adapters/storage/postgres/factory.js';
import type { StorageRuntime } from '../adapters/storage/postgres/factory.js';
import type { ResolvedStorageConfig } from '../adapters/storage/postgres/storage-service.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';

export interface RuntimeGroupDb {
  countConversationRoutesByJidPrefix(jidPrefix: string): Promise<number>;
  getAllConversationRoutes(): Promise<Record<string, ConversationRoute>>;
  getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit?: number,
  ): Promise<NewMessage[]>;
  setConversationRoute(jid: string, group: ConversationRoute): Promise<void>;
  deleteConversationRoute(jid: string): Promise<void>;
  deleteSession(workspaceFolder: string): Promise<void>;
  getFileArtifactStore(): FileArtifactStore;
  close(): Promise<void>;
}

function resolveStorageConfig(runtimeHome: string): ResolvedStorageConfig {
  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const postgresUrlEnv = settings.storage.postgres.urlEnv;
  return {
    postgresUrl:
      env[postgresUrlEnv]?.trim() ||
      process.env[postgresUrlEnv]?.trim() ||
      null,
    postgresUrlEnv,
    postgresSchema: settings.storage.postgres.schema,
  };
}

function normalizePrefix(jidPrefix: string): string {
  return jidPrefix.endsWith('%') ? jidPrefix.slice(0, -1) : jidPrefix;
}

function createProviderRuntimeGroupDb(runtime: StorageRuntime): RuntimeGroupDb {
  return {
    async countConversationRoutesByJidPrefix(
      jidPrefix: string,
    ): Promise<number> {
      const prefix = normalizePrefix(jidPrefix);
      const groups = await runtime.ops.getAllConversationRoutes();
      return Object.keys(groups).filter((jid) => jid.startsWith(prefix)).length;
    },

    async getAllConversationRoutes(): Promise<
      Record<string, ConversationRoute>
    > {
      return runtime.ops.getAllConversationRoutes();
    },

    async getMessagesSince(
      chatJid: string,
      sinceCursor: string,
      limit?: number,
    ): Promise<NewMessage[]> {
      return runtime.ops.getMessagesSince(chatJid, sinceCursor, limit);
    },

    async setConversationRoute(
      jid: string,
      group: ConversationRoute,
    ): Promise<void> {
      if (!isValidWorkspaceFolder(group.folder)) {
        throw new Error(
          `Invalid workspace folder "${group.folder}" for JID ${jid}`,
        );
      }
      await runtime.ops.setConversationRoute(jid, group);
    },

    async deleteConversationRoute(jid: string): Promise<void> {
      await runtime.ops.deleteConversationRoute(jid);
    },

    async deleteSession(workspaceFolder: string): Promise<void> {
      await runtime.ops.deleteSessionsByAgentFolder(workspaceFolder);
    },

    getFileArtifactStore(): FileArtifactStore {
      return runtime.fileArtifacts;
    },

    async close(): Promise<void> {
      await runtime.service.close();
    },
  };
}

export async function openRuntimeGroupDb(
  runtimeHome: string,
  options: { migrate?: boolean } = {},
): Promise<RuntimeGroupDb> {
  const config = resolveStorageConfig(runtimeHome);
  const runtime = createStorageRuntime(config);
  if (options.migrate !== false) {
    await runtime.service.migrate();
  }
  return createProviderRuntimeGroupDb(runtime);
}

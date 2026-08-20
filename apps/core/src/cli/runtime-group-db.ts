import { NewMessage, ConversationRoute } from '../domain/types.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { createStorageRuntime } from '../adapters/storage/postgres/factory.js';
import type { StorageRuntime } from '../adapters/storage/postgres/factory.js';
import type { ResolvedStorageConfig } from '../adapters/storage/postgres/storage-service.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';

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
  deleteSession(
    workspaceFolder: string,
    threadId?: string | null,
    scope?: {
      conversationJid?: string;
      providerAccountId?: string;
      conversationKind?: 'dm' | 'channel';
      agentId?: string;
    },
  ): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  getFileArtifactStore(): FileArtifactStore;
  getRuntimeSecrets?(): RuntimeSecretProvider;
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

    async deleteSession(
      workspaceFolder: string,
      threadId?: string | null,
      scope?: {
        conversationJid?: string;
        providerAccountId?: string;
        conversationKind?: 'dm' | 'channel';
        agentId?: string;
      },
    ): Promise<void> {
      // Scope the delete to the route's own conversation so a folder shared by
      // other live routes is never wiped (no folder-wide deletion to race).
      await runtime.ops.deleteSession(workspaceFolder, threadId ?? null, {
        conversationJid: scope?.conversationJid,
        providerAccountId: scope?.providerAccountId,
        conversationKind: scope?.conversationKind,
        agentId: scope?.agentId,
      });
    },

    async deleteJob(jobId: string): Promise<void> {
      await runtime.ops.deleteJob(jobId);
    },

    getFileArtifactStore(): FileArtifactStore {
      return runtime.fileArtifacts;
    },

    getRuntimeSecrets(): RuntimeSecretProvider {
      return createRepositoryRuntimeSecretProvider({
        appId: 'default' as never,
        repository: runtime.repositories.capabilitySecrets,
      });
    },

    async close(): Promise<void> {
      await runtime.service.close();
    },
  };
}

export async function openRuntimeGroupDb(
  runtimeHome: string,
): Promise<RuntimeGroupDb> {
  const config = resolveStorageConfig(runtimeHome);
  const runtime = createStorageRuntime(config);
  await runtime.service.assertMigrationsCurrent();
  return createProviderRuntimeGroupDb(runtime);
}

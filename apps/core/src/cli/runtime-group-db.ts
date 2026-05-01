import { NewMessage, RegisteredGroup } from '../domain/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { createStorageRuntime } from '../adapters/storage/postgres/factory.js';
import type { StorageRuntime } from '../adapters/storage/postgres/factory.js';
import type { ResolvedStorageConfig } from '../adapters/storage/postgres/storage-service.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';

export interface RuntimeGroupDb {
  countRegisteredGroupsByJidPrefix(jidPrefix: string): Promise<number>;
  getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>>;
  getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit?: number,
  ): Promise<NewMessage[]>;
  setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void>;
  deleteRegisteredGroup(jid: string): Promise<void>;
  deleteSession(groupFolder: string): Promise<void>;
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
    async countRegisteredGroupsByJidPrefix(jidPrefix: string): Promise<number> {
      const prefix = normalizePrefix(jidPrefix);
      const groups = await runtime.ops.getAllRegisteredGroups();
      return Object.keys(groups).filter((jid) => jid.startsWith(prefix)).length;
    },

    async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
      return runtime.ops.getAllRegisteredGroups();
    },

    async getMessagesSince(
      chatJid: string,
      sinceCursor: string,
      limit?: number,
    ): Promise<NewMessage[]> {
      return runtime.ops.getMessagesSince(chatJid, sinceCursor, limit);
    },

    async setRegisteredGroup(
      jid: string,
      group: RegisteredGroup,
    ): Promise<void> {
      if (!isValidGroupFolder(group.folder)) {
        throw new Error(
          `Invalid group folder "${group.folder}" for JID ${jid}`,
        );
      }
      await runtime.ops.setRegisteredGroup(jid, group);
    },

    async deleteRegisteredGroup(jid: string): Promise<void> {
      await runtime.ops.deleteRegisteredGroup(jid);
    },

    async deleteSession(groupFolder: string): Promise<void> {
      await runtime.ops.deleteSessionsByGroupFolder(groupFolder);
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

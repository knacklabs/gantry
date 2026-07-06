import { PostgresBrainRepository } from '../adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import {
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
} from '../config/index.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { AppId } from '../domain/app/app.js';
import { DEFAULT_MEMORY_APP_ID } from '../memory/app-memory-boundaries.js';
import { createEmbeddingProvider } from '../memory/memory-embeddings.js';
import { BrainService } from './brain-service.js';

export function createRuntimeBrainService(appId: string): BrainService {
  const storage = getRuntimeStorage();
  const repository = new PostgresBrainRepository(storage.service.db);
  if (MEMORY_EMBED_PROVIDER === 'disabled') {
    return new BrainService(repository);
  }
  return new BrainService(repository, {
    embedding: {
      config: {
        provider: MEMORY_EMBED_PROVIDER,
        model: MEMORY_EMBED_MODEL,
        dimensions: MEMORY_EMBED_DIMENSIONS,
      },
      provider: createEmbeddingProvider(MEMORY_EMBED_PROVIDER, {
        model: MEMORY_EMBED_MODEL,
        dimensions: MEMORY_EMBED_DIMENSIONS,
        appId: appId as AppId,
      }),
    },
  });
}

export interface OpenedBrain {
  brain: BrainService;
  appId: string;
  close: () => Promise<void>;
}

export async function openBrainFromHome(
  runtimeHome: string,
): Promise<OpenedBrain> {
  process.env.GANTRY_HOME = runtimeHome;
  const { initializeRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  const storage = await initializeRuntimeStorage();
  const repository = new PostgresBrainRepository(storage.service.db);
  const settings = loadRuntimeSettings(runtimeHome);
  const embeddings = settings.memory.embeddings;
  const brain =
    embeddings.enabled && embeddings.provider !== 'disabled'
      ? new BrainService(repository, {
          embedding: {
            config: {
              provider: embeddings.provider,
              model: embeddings.model,
              dimensions: embeddings.dimensions,
            },
            provider: createEmbeddingProvider(embeddings.provider, {
              model: embeddings.model,
              dimensions: embeddings.dimensions,
              appId: DEFAULT_MEMORY_APP_ID as AppId,
            }),
          },
        })
      : new BrainService(repository);
  return {
    brain,
    appId: DEFAULT_MEMORY_APP_ID,
    close: async () => {
      await storage.runtimeEventNotifier.close().catch(() => {});
      await storage.service.close().catch(() => {});
    },
  };
}

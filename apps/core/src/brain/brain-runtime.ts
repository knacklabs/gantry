import { PostgresBrainRepository } from '../adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import {
  getRuntimeSettingsForConfig,
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
} from '../config/index.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { AppId } from '../domain/app/app.js';
import { DEFAULT_MEMORY_APP_ID } from '../memory/app-memory-boundaries.js';
import { listObserverActiveMemoryValues } from '../memory/app-memory-item-queries.js';
import { CachedEmbeddingProvider } from '../memory/memory-embedding-cache.js';
import { PostgresEmbeddingCacheStore } from '../memory/memory-embedding-cache-store.js';
import { createEmbeddingProvider } from '../memory/memory-embeddings.js';
import {
  BrainChannelHarvester,
  type BrainChannelHarvestTap,
} from './brain-channel-harvest.js';
import {
  runBrainDreamBatch,
  type BrainDreamProposalPort,
} from './brain-dreaming.js';
import { BrainService } from './brain-service.js';
import { OBSERVER_CURSOR_SUBJECT } from './observer-insight-emission.js';

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

export function createRuntimeBrainChannelHarvestTap(): BrainChannelHarvestTap {
  // One harvester per storage generation: its per-slug pending map is the
  // concurrency guard, so it must be shared across persistence queue slots.
  let harvester: BrainChannelHarvester | null = null;
  let boundDb: unknown = null;
  return {
    harvest: async (input) => {
      const storage = getRuntimeStorage();
      if (!harvester || boundDb !== storage.service.db) {
        harvester = new BrainChannelHarvester(
          new BrainService(new PostgresBrainRepository(storage.service.db)),
        );
        boundDb = storage.service.db;
      }
      // Evaluate the opt-in against fresh (mtime-cached) settings so live
      // brain_harvest toggles apply without a restart; the wiring passes a
      // startup snapshot that goes stale after a settings reload.
      await harvester.harvest({
        ...input,
        settings: getRuntimeSettingsForConfig(),
      });
    },
  };
}

export function countRuntimeBrainHarvestEnabledConversations(): number {
  return Object.values(getRuntimeSettingsForConfig().conversations).filter(
    (conversation) => conversation.brainHarvest,
  ).length;
}

export async function runRuntimeBrainDreamBatch(input: {
  appId: string;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  proposer?: BrainDreamProposalPort;
  observerEnabled?: boolean;
  observerOwnerRecipient?: string | null;
}) {
  const storage = getRuntimeStorage();
  const repository = new PostgresBrainRepository(storage.service.db);
  if (input.observerEnabled && !input.observerOwnerRecipient) {
    throw new Error('Observer owner recipient is not configured');
  }
  let observerEmbedding;
  if (input.observerEnabled && MEMORY_EMBED_PROVIDER !== 'disabled') {
    const inner = createEmbeddingProvider(MEMORY_EMBED_PROVIDER, {
      model: MEMORY_EMBED_MODEL,
      dimensions: MEMORY_EMBED_DIMENSIONS,
      appId: input.appId as AppId,
    });
    const cached = new CachedEmbeddingProvider(
      inner,
      new PostgresEmbeddingCacheStore(storage.service.db),
      MEMORY_EMBED_MODEL,
      MEMORY_EMBED_DIMENSIONS,
    );
    observerEmbedding = {
      isEnabled: () => cached.isEnabled(),
      validateConfiguration: () => cached.validateConfiguration(),
      validateReady: (options?: { signal?: AbortSignal }) =>
        inner.validateReady?.(options) ?? Promise.resolve(),
      expectedDimensions: () =>
        inner.expectedDimensions?.() ?? MEMORY_EMBED_DIMENSIONS,
      embedMany: cached.embedMany.bind(cached),
      embedOne: cached.embedOne.bind(cached),
    };
  }
  return runBrainDreamBatch({
    brain: new BrainService(repository),
    repository,
    appId: input.appId,
    limit: input.limit,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    proposer: input.proposer,
    observer: input.observerEnabled
      ? {
          enabled: true,
          ownerRecipient: input.observerOwnerRecipient!,
          cursorSubject: OBSERVER_CURSOR_SUBJECT,
          repository: storage.repositories.observerInsights,
          patterns: storage.repositories.patternCandidates,
          activeMemory: {
            listActiveValues: ({ appId, subject }) =>
              listObserverActiveMemoryValues({
                db: storage.service.db,
                appId,
                subject,
              }),
          },
          embedding: observerEmbedding,
          embeddingModel: MEMORY_EMBED_MODEL,
          embeddingDimensions: MEMORY_EMBED_DIMENSIONS,
        }
      : undefined,
  });
}

export interface OpenedBrain {
  brain: BrainService;
  appId: string;
  harvestEnabledConversations: number;
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
    harvestEnabledConversations: Object.values(settings.conversations).filter(
      (conversation) => conversation.brainHarvest,
    ).length,
    close: async () => {
      await storage.runtimeEventNotifier.close().catch(() => {});
      await storage.service.close().catch(() => {});
    },
  };
}

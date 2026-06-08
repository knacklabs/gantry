import { runtimeMemorySettings } from './memory-state.js';
import {
  DEFAULT_MEMORY_BACKFILL_CRON,
  DEFAULT_MEMORY_BACKFILL_ENABLED,
  DEFAULT_MEMORY_BACKFILL_MAX_ITEMS_PER_RUN,
  DEFAULT_MEMORY_BACKFILL_MODE,
  DEFAULT_MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS,
  DEFAULT_MEMORY_DREAMING_CRON,
  DEFAULT_MEMORY_EMBED_BATCH_SIZE,
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
} from './settings/runtime-settings-defaults.js';
import type { MemoryBackfillMode } from './settings/runtime-settings-types.js';

export const MEMORY_DREAMING_CRON =
  runtimeMemorySettings.dreamingCron ?? DEFAULT_MEMORY_DREAMING_CRON;

export const MEMORY_EMBED_BATCH_SIZE =
  runtimeMemorySettings.embedBatchSize ?? DEFAULT_MEMORY_EMBED_BATCH_SIZE;

export const MEMORY_MAINTENANCE_MAX_PENDING =
  runtimeMemorySettings.maintenanceMaxPending ??
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING;

export const MEMORY_BACKFILL_ENABLED =
  runtimeMemorySettings.backfillEnabled ?? DEFAULT_MEMORY_BACKFILL_ENABLED;

export const MEMORY_BACKFILL_CRON =
  runtimeMemorySettings.backfillCron ?? DEFAULT_MEMORY_BACKFILL_CRON;

export const MEMORY_BACKFILL_MAX_ITEMS_PER_RUN =
  runtimeMemorySettings.backfillMaxItemsPerRun ??
  DEFAULT_MEMORY_BACKFILL_MAX_ITEMS_PER_RUN;

export const MEMORY_BACKFILL_MODE: MemoryBackfillMode =
  (runtimeMemorySettings.backfillMode as MemoryBackfillMode | undefined) ??
  DEFAULT_MEMORY_BACKFILL_MODE;

export const MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS =
  runtimeMemorySettings.backfillProviderBatchMinItems ??
  DEFAULT_MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS;

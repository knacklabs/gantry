import { runtimeMemorySettings } from './memory-state.js';
import {
  DEFAULT_MEMORY_DREAMING_CRON,
  DEFAULT_MEMORY_EMBED_BATCH_SIZE,
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
} from './settings/runtime-settings-defaults.js';

export const MEMORY_DREAMING_CRON =
  runtimeMemorySettings.dreamingCron ?? DEFAULT_MEMORY_DREAMING_CRON;

export const MEMORY_EMBED_BATCH_SIZE =
  runtimeMemorySettings.embedBatchSize ?? DEFAULT_MEMORY_EMBED_BATCH_SIZE;

export const MEMORY_MAINTENANCE_MAX_PENDING =
  runtimeMemorySettings.maintenanceMaxPending ??
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING;

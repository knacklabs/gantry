import { getGantryHome } from '../shared/gantry-home.js';
import { envConfig } from './env/index.js';
import { DEFAULT_MEMORY_DREAMING_ALERTS } from './settings/runtime-settings-defaults.js';
import {
  readRuntimeMemorySettingsSnapshot,
  type RuntimeMemorySettingsSnapshot,
} from './settings/runtime-settings.js';

const GANTRY_HOME_RAW =
  process.env.GANTRY_HOME?.trim() || envConfig.GANTRY_HOME?.trim() || '';
export const MEMORY_CONFIG_HOME = getGantryHome(GANTRY_HOME_RAW);

export let runtimeMemorySettings: RuntimeMemorySettingsSnapshot = {};
let runtimeMemorySettingsError: Error | null = null;
try {
  runtimeMemorySettings = readRuntimeMemorySettingsSnapshot(MEMORY_CONFIG_HOME);
} catch (err) {
  runtimeMemorySettingsError =
    err instanceof Error ? err : new Error(String(err));
}
if (runtimeMemorySettingsError) {
  throw new Error(
    `Invalid runtime memory settings: ${runtimeMemorySettingsError.message}`,
  );
}

export const RUNTIME_MEMORY_ENABLED = runtimeMemorySettings.enabled ?? true;
export const RUNTIME_MEMORY_DREAMING_ENABLED =
  runtimeMemorySettings.dreamingEnabled ?? false;
export const RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED =
  runtimeMemorySettings.dreamingAlerts ?? DEFAULT_MEMORY_DREAMING_ALERTS;

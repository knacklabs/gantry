import type { AppId } from '../../domain/app/app.js';
import { applyRuntimeSettingsDesiredState } from './restart-sync.js';
import { saveRuntimeSettings } from './runtime-settings.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export interface DesiredSettingsWriteStorage {
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  close?: () => Promise<void>;
}

let storageProvider:
  | (() => Promise<DesiredSettingsWriteStorage | undefined>)
  | undefined;

export function configureDesiredSettingsStorageProvider(
  provider:
    | (() => Promise<DesiredSettingsWriteStorage | undefined>)
    | undefined,
): void {
  storageProvider = provider;
}

/**
 * Single desired-state write path that gracefully degrades.
 *
 * When runtime storage is reachable, the settings are reconciled through the
 * owner (`applyRuntimeSettingsDesiredState`). When storage is absent (offline
 * CLI, no Postgres), the settings are written to settings.yaml only; the
 * running runtime reconciles on reload. Once reconciliation starts, failures
 * must propagate so invalid desired state is not persisted as a YAML-only
 * fallback.
 */
export async function writeDesiredRuntimeSettings(input: {
  runtimeHome: string;
  settings: RuntimeSettings;
  previousSettings?: RuntimeSettings;
  appId?: AppId;
}): Promise<{ reconciled: boolean }> {
  const storage = storageProvider ? await storageProvider() : undefined;
  if (!storage) {
    saveRuntimeSettings(input.runtimeHome, input.settings);
    return { reconciled: false };
  }

  try {
    await applyRuntimeSettingsDesiredState({
      runtimeHome: input.runtimeHome,
      settings: input.settings,
      previousSettings: input.previousSettings,
      appId: input.appId ?? ('default' as AppId),
      ops: storage.ops,
      repositories: storage.repositories,
    });
    return { reconciled: true };
  } finally {
    await storage.close?.();
  }
}

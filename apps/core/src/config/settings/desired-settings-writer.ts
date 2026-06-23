import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import { applyRuntimeSettingsDesiredState } from './restart-sync.js';
import { saveRuntimeSettings } from './runtime-settings.js';
import {
  importWorkstationSettings,
  type SettingsRevisionMirror,
} from './settings-import-service.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export interface DesiredSettingsWriteStorage {
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  settingsRevisions?: SettingsRevisionRepository;
  pool?: SettingsRevisionMirror['pool'];
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
 * When runtime storage is reachable, workstation settings are reconciled through
 * the owner (`applyRuntimeSettingsDesiredState`) and fleet settings append the
 * settings revision that workers boot from. When storage is absent (offline CLI,
 * no Postgres), only workstation settings may fall back to settings.yaml.
 */
export async function writeDesiredRuntimeSettings(input: {
  runtimeHome: string;
  settings: RuntimeSettings;
  previousSettings?: RuntimeSettings;
  appId?: AppId;
  createdBy?: string;
}): Promise<{ reconciled: boolean }> {
  const storage = storageProvider ? await storageProvider() : undefined;
  const deploymentMode = input.settings.runtime.deploymentMode;
  if (deploymentMode === 'fleet' && !storage) {
    throw new Error(
      'Fleet settings mutation requires runtime storage so settings_revisions can be durably appended.',
    );
  }
  if (!storage) {
    saveRuntimeSettings(input.runtimeHome, input.settings);
    return { reconciled: false };
  }
  if (!deploymentMode) {
    await storage.close?.();
    throw new Error(
      'Settings mutation requires runtime.deploymentMode when runtime storage is available.',
    );
  }
  if (deploymentMode === 'fleet' && !storage.settingsRevisions) {
    await storage.close?.();
    throw new Error(
      'Fleet settings mutation requires the settings revisions repository.',
    );
  }
  try {
    if (deploymentMode === 'fleet') {
      const appId = input.appId ?? ('default' as AppId);
      await importWorkstationSettings(
        {
          runtimeHome: input.runtimeHome,
          ops: storage.ops,
          repositories: storage.repositories,
          appId,
          previousSettings: input.previousSettings,
          revisionMirror: {
            settingsRevisions: storage.settingsRevisions!,
            pool: storage.pool,
            createdBy: input.createdBy ?? 'cli:desired-settings-write',
          },
          revisionMirrorRequired: true,
        },
        input.settings,
      );
      return { reconciled: true };
    }
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

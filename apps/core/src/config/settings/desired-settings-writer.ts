import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';
import {
  importWorkstationSettings,
  settingsFromRevisionDocument,
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
  | ((input?: {
      settings?: RuntimeSettings;
    }) => Promise<DesiredSettingsWriteStorage | undefined>)
  | undefined;

export function configureDesiredSettingsStorageProvider(
  provider:
    | ((input?: {
        settings?: RuntimeSettings;
      }) => Promise<DesiredSettingsWriteStorage | undefined>)
    | undefined,
): void {
  storageProvider = provider;
}

/**
 * Single desired-state write path.
 *
 * Postgres `settings_revisions` is the durable authority for managed runtime
 * settings. The local `settings.yaml` file is updated by the shared import path
 * after the revision append succeeds.
 */
export async function writeDesiredRuntimeSettings(input: {
  runtimeHome: string;
  settings: RuntimeSettings;
  previousSettings?: RuntimeSettings;
  appId?: AppId;
  createdBy?: string;
}): Promise<{ reconciled: boolean }> {
  const deploymentMode = input.settings.runtime.deploymentMode;
  if (!storageProvider) {
    saveRuntimeSettings(input.runtimeHome, input.settings);
    return { reconciled: false };
  }
  const storage = await storageProvider({ settings: input.settings });
  if (!storage) {
    throw new Error(
      'Settings mutation requires runtime storage so settings_revisions can be durably appended.',
    );
  }
  if (!deploymentMode) {
    await storage.close?.();
    throw new Error(
      'Settings mutation requires runtime.deploymentMode when runtime storage is available.',
    );
  }
  if (!storage.settingsRevisions) {
    await storage.close?.();
    throw new Error(
      'Settings mutation requires the settings revisions repository.',
    );
  }
  try {
    const appId = input.appId ?? ('default' as AppId);
    const previousSettings =
      input.previousSettings ?? loadRuntimeSettings(input.runtimeHome);
    await importWorkstationSettings(
      {
        runtimeHome: input.runtimeHome,
        ops: storage.ops,
        repositories: storage.repositories,
        appId,
        previousSettings,
        revisionMirror: {
          settingsRevisions: storage.settingsRevisions,
          pool: storage.pool,
          createdBy: input.createdBy ?? 'cli:desired-settings-write',
        },
        revisionMirrorRequired: true,
      },
      input.settings,
    );
    return { reconciled: true };
  } finally {
    await storage.close?.();
  }
}

export async function loadDesiredRuntimeSettingsForWrite(input: {
  runtimeHome: string;
  appId?: AppId;
  settings?: RuntimeSettings;
}): Promise<RuntimeSettings> {
  const fileSettings = input.settings ?? loadRuntimeSettings(input.runtimeHome);
  if (!storageProvider) return fileSettings;

  const storage = await storageProvider({ settings: fileSettings });
  if (!storage) {
    throw new Error(
      'Settings mutation requires runtime storage so settings_revisions can be durably read.',
    );
  }
  try {
    if (!storage.settingsRevisions) return fileSettings;
    const appId = input.appId ?? ('default' as AppId);
    const latest =
      await storage.settingsRevisions.getLatestSettingsRevision(appId);
    if (!latest) return fileSettings;
    return settingsFromRevisionDocument(latest.settingsDocument);
  } finally {
    await storage.close?.();
  }
}

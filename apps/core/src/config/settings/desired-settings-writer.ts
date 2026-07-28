import { isDeepStrictEqual } from 'node:util';

import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import type { RuntimeLeasePort } from '../../domain/ports/runtime-lease.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';
import { classifySettingsChanges } from './desired-state-service-helpers.js';
import {
  importWorkstationSettings,
  settingsFromRevisionDocument,
  type SettingsRevisionMirror,
} from './settings-import-service.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service-types.js';
import { resolveRuntimeHome, settingsFilePath } from './runtime-home.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export interface DesiredSettingsWriteStorage {
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  settingsRevisions?: SettingsRevisionRepository;
  pool?: SettingsRevisionMirror['pool'];
  leases?: RuntimeLeasePort;
  close?: () => Promise<void>;
}

export interface DesiredRuntimeSettingsWriteResult {
  reconciled: boolean;
  restartRequired: string[];
}

export function noteRestartRequired(input: {
  restartRequired?: readonly string[];
}): void {
  if (input.restartRequired?.length) {
    console.log(
      'This change requires a restart to take effect — run `gantry restart`.',
    );
  }
}

let storageProvider:
  | ((input?: {
      settings?: RuntimeSettings;
    }) => Promise<DesiredSettingsWriteStorage | undefined>)
  | undefined;

interface DesiredSettingsWriteChain {
  tail: Promise<void>;
}

const desiredSettingsWriteChainByTarget = new Map<
  string,
  DesiredSettingsWriteChain
>();

export function configureDesiredSettingsStorageProvider(
  provider:
    | ((input?: {
        settings?: RuntimeSettings;
      }) => Promise<DesiredSettingsWriteStorage | undefined>)
    | undefined,
): void {
  storageProvider = provider;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applySettingsSnapshotDelta(
  previous: unknown,
  desired: unknown,
  current: unknown,
): unknown {
  if (isDeepStrictEqual(previous, desired)) return current;
  if (
    !isSettingsRecord(previous) ||
    !isSettingsRecord(desired) ||
    !isSettingsRecord(current)
  ) {
    return structuredClone(desired);
  }

  const rebased: Record<string, unknown> = { ...current };
  for (const key of new Set([
    ...Object.keys(previous),
    ...Object.keys(desired),
  ])) {
    if (!(key in desired)) {
      delete rebased[key];
      continue;
    }
    if (!(key in previous)) {
      rebased[key] = structuredClone(desired[key]);
      continue;
    }
    rebased[key] = applySettingsSnapshotDelta(
      previous[key],
      desired[key],
      current[key],
    );
  }
  return rebased;
}

async function writeFileBackedDesiredRuntimeSettings(input: {
  runtimeHome: string;
  settings: RuntimeSettings;
  previousSettings?: RuntimeSettings;
}): Promise<DesiredRuntimeSettingsWriteResult> {
  const targetPath = settingsFilePath(resolveRuntimeHome(input.runtimeHome));
  let chain = desiredSettingsWriteChainByTarget.get(targetPath);
  if (!chain) {
    chain = { tail: Promise.resolve() };
    desiredSettingsWriteChainByTarget.set(targetPath, chain);
  }

  // The delta must be measured against what the CALLER saw, so when no baseline is
  // supplied it is read BEFORE enqueueing. Reading it inside the critical section
  // would sample the state left by the predecessor write, and the caller's unchanged
  // keys would then look like intentional reverts — silently undoing that
  // predecessor's update, which is the very race this serialization exists to close.
  const callerBaseline =
    input.previousSettings ?? loadRuntimeSettings(input.runtimeHome);

  const previousWrite = chain.tail;
  const write = previousWrite.then(async () => {
    const currentSettings = loadRuntimeSettings(input.runtimeHome);
    const restartRequired = classifySettingsChanges(
      callerBaseline,
      input.settings,
    ).restartRequired;
    const rebasedSettings = applySettingsSnapshotDelta(
      callerBaseline,
      input.settings,
      currentSettings,
    ) as RuntimeSettings;
    await saveRuntimeSettings(input.runtimeHome, rebasedSettings);
    return { reconciled: false, restartRequired };
  });
  const settledWrite = write.then(
    () => undefined,
    () => undefined,
  );
  chain.tail = settledWrite;
  void settledWrite.then(() => {
    if (
      desiredSettingsWriteChainByTarget.get(targetPath) === chain &&
      chain.tail === settledWrite
    ) {
      desiredSettingsWriteChainByTarget.delete(targetPath);
    }
  });
  return write;
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
}): Promise<DesiredRuntimeSettingsWriteResult> {
  const deploymentMode = input.settings.runtime.deploymentMode;
  if (!storageProvider) {
    return writeFileBackedDesiredRuntimeSettings(input);
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
    const restartRequired = classifySettingsChanges(
      previousSettings,
      input.settings,
    ).restartRequired;
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
        leases: storage.leases,
      },
      input.settings,
    );
    return { reconciled: true, restartRequired };
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

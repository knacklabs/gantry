import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import { type SettingsRevisionMirror } from './settings-import-service.js';
import type { SettingsDesiredStateOps, SettingsDesiredStateRepositories } from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
export interface DesiredSettingsWriteStorage {
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    settingsRevisions?: SettingsRevisionRepository;
    pool?: SettingsRevisionMirror['pool'];
    close?: () => Promise<void>;
}
export interface DesiredRuntimeSettingsWriteResult {
    reconciled: boolean;
    restartRequired: string[];
}
export declare function noteRestartRequired(input: {
    restartRequired?: readonly string[];
}): void;
export declare function configureDesiredSettingsStorageProvider(provider: ((input?: {
    settings?: RuntimeSettings;
}) => Promise<DesiredSettingsWriteStorage | undefined>) | undefined): void;
/**
 * Single desired-state write path.
 *
 * Postgres `settings_revisions` is the durable authority for managed runtime
 * settings. The local `settings.yaml` file is updated by the shared import path
 * after the revision append succeeds.
 */
export declare function writeDesiredRuntimeSettings(input: {
    runtimeHome: string;
    settings: RuntimeSettings;
    previousSettings?: RuntimeSettings;
    appId?: AppId;
    createdBy?: string;
}): Promise<DesiredRuntimeSettingsWriteResult>;
export declare function loadDesiredRuntimeSettingsForWrite(input: {
    runtimeHome: string;
    appId?: AppId;
    settings?: RuntimeSettings;
}): Promise<RuntimeSettings>;

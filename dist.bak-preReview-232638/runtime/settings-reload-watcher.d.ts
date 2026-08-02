import type { RuntimeApp } from '../app/bootstrap/runtime-app.js';
import { type SettingsDesiredStateRepositories, type SettingsDesiredStateOps } from '../config/settings/desired-state-service.js';
import { type SettingsRevisionMirror } from '../config/settings/settings-import-service.js';
import type { AppId } from '../domain/app/app.js';
import type { SettingsRevisionRepository } from '../domain/ports/fleet-capability-state.js';
export interface SettingsReloadWatcherOptions {
    runtimeHome: string;
    app: RuntimeApp;
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    appId?: AppId;
    settingsRevisions?: SettingsRevisionRepository;
    settingsRevisionPool?: SettingsRevisionMirror['pool'];
    pollIntervalMs?: number;
}
export interface SettingsReloadWatcher {
    close(): void;
}
export declare function startSettingsReloadWatcher(options: SettingsReloadWatcherOptions): SettingsReloadWatcher;

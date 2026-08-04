import { RuntimeSettings, loadRuntimeSettings } from '../../config/settings/runtime-settings.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import { initializeRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { importWorkstationSettings } from '../../config/settings/settings-import-service.js';
import { RuntimeApp } from './runtime-app.js';
interface SettingsImportPreflightFailure {
    summary: string;
    details: string[];
}
interface SettingsImportPreflightResult {
    ok: boolean;
    failure?: SettingsImportPreflightFailure;
}
type ValidateSettingsImportPreflight = (runtimeHome: string) => SettingsImportPreflightResult;
type FormatSettingsImportPreflightFailure = (failure: SettingsImportPreflightFailure) => string;
interface StartupDeps {
    ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
    initializeRuntimeStorage: typeof initializeRuntimeStorage;
    loadRuntimeSettings: typeof loadRuntimeSettings;
    importWorkstationSettings: typeof importWorkstationSettings;
    settingsFileExists: (runtimeHome: string) => boolean;
    validateSettingsImportPreflight: ValidateSettingsImportPreflight;
    formatRuntimePreflightFailure: FormatSettingsImportPreflightFailure;
    logger: Pick<typeof logger, 'info' | 'warn'>;
    settingsAuthority: 'file' | 'revision';
}
export interface StartupResult {
    runtimeSettings: RuntimeSettings;
    initTracingFromSettings: (settings: RuntimeSettings) => void;
    closeTracing: () => Promise<void>;
}
export declare function runStartup(app: RuntimeApp, deps?: Partial<StartupDeps>): Promise<StartupResult>;
export {};

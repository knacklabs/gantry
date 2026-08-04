import type { AppId } from '../../domain/app/app.js';
import type { SettingsDesiredStateServiceDeps } from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
export declare function exportCurrentDesiredState(input: {
    deps: SettingsDesiredStateServiceDeps;
    appId: AppId;
    settings: RuntimeSettings;
}): Promise<RuntimeSettings>;

import type { AppId } from '../../domain/app/app.js';
import type { SettingsDesiredStateServiceDeps } from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
export declare function validateDesiredStateCapabilityReferences(input: {
    appId: AppId;
    deps: SettingsDesiredStateServiceDeps;
    settings: RuntimeSettings;
}): Promise<string[]>;

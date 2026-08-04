import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import type { SettingsRevisionMirror } from './settings-import-service.js';
import type { SettingsDesiredStateOps, SettingsDesiredStateRepositories } from './desired-state-service.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
type ProjectionSettingsOverrides = {
    providerAccount?: {
        id: string;
        runtimeSecretRefs: Record<string, string>;
    };
};
export declare function applyRuntimeSettingsDesiredState(input: {
    runtimeHome: string;
    settings: RuntimeSettings;
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    appId?: AppId;
    previousSettings?: RuntimeSettings;
    reloadRuntimeState?: () => Promise<void>;
}): Promise<RuntimeSettings>;
export declare function syncRuntimeSettingsFromProjection(input: {
    runtimeHome: string;
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    appId?: AppId;
    reloadRuntimeState?: () => Promise<void>;
    settingsRevisions?: SettingsRevisionRepository;
    pool?: SettingsRevisionMirror['pool'];
    createdBy?: string;
    overrides?: ProjectionSettingsOverrides;
}): Promise<void>;
export declare function addAgentToolRulesToSyncedRuntimeSettings(input: {
    runtimeHome: string;
    agentFolder: string;
    rules: readonly string[];
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    appId?: AppId;
    reloadRuntimeState?: () => Promise<void>;
    settingsRevisions?: SettingsRevisionRepository;
    pool?: SettingsRevisionMirror['pool'];
    createdBy?: string;
}): Promise<void>;
export declare function addActiveMcpSourcesToRuntimeSettings(input: {
    settings: RuntimeSettings;
    agentFolder: string;
    repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
    appId: AppId;
}): Promise<void>;
export declare function removeAgentToolRulesFromSyncedRuntimeSettings(input: {
    runtimeHome: string;
    agentFolder: string;
    rules: readonly string[];
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    appId?: AppId;
    reloadRuntimeState?: () => Promise<void>;
    settingsRevisions?: SettingsRevisionRepository;
    pool?: SettingsRevisionMirror['pool'];
    createdBy?: string;
}): Promise<void>;
export {};

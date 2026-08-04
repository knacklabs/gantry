export { agentIdForFolder, classifySettingsChanges, } from './desired-state-service-helpers.js';
export type { SettingsChangeClassification, SettingsDesiredStateDriftReport, SettingsDesiredStateOps, SettingsDesiredStateRepositories, SettingsDesiredStateServiceDeps, SettingsReconcileResult, StoredAgentBinding, } from './desired-state-service-types.js';
import type { SettingsDesiredStateDriftReport, SettingsDesiredStateServiceDeps, SettingsReconcileResult } from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
export declare class SettingsDesiredStateService {
    private readonly deps;
    private readonly appId;
    private readonly clock;
    constructor(deps: SettingsDesiredStateServiceDeps);
    exportCurrent(settings: RuntimeSettings): Promise<RuntimeSettings>;
    normalizeConfiguredCapabilities(settings: RuntimeSettings): Promise<{
        settings: RuntimeSettings;
        changed: boolean;
        changedAgentFolders: string[];
    }>;
    drift(settings: RuntimeSettings): Promise<SettingsDesiredStateDriftReport>;
    reconcile(settings: RuntimeSettings): Promise<SettingsReconcileResult>;
    private saveDesiredProviderAccount;
    private ensureDesiredConversation;
    private rebindConfiguredConversationBindings;
    private ensureDesiredConversationThread;
    private replaceStoredConversationApprovers;
    private findConfiguredConversation;
    validateCapabilityReferences(settings: RuntimeSettings): Promise<string[]>;
    private replaceCapabilities;
}

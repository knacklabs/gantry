import type { AppId } from '../../domain/app/app.js';
import type { ConversationRepository, ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type { AgentHarness } from '../../shared/agent-engine.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import { type JobAppSessionLookupPort } from '../jobs/job-access.js';
import { type RequiredModelCredentialProvidersSettings } from '../model-resolution/required-model-credential-providers.js';
import { type ControlPlaneReadModel, type ControlPlaneSettingsReadModelInput } from './control-plane-read-model.js';
import { type ControlPlaneSettingsInputView } from './control-plane-settings-inputs.js';
export type ControlPlaneStorageSettings = ControlPlaneSettingsReadModelInput['settings'] & ControlPlaneSettingsInputView & RequiredModelCredentialProvidersSettings;
export type EffectiveControlRuntimeSettings = ControlPlaneStorageSettings & ControlObserverSettingsView & {
    memory: {
        enabled: boolean;
        dreaming: {
            enabled: boolean;
        };
    };
    modelFamilies?: Record<string, string[]>;
};
export type ControlAgentSettingsView = {
    agents: Record<string, {
        persona?: string;
        delegates: string[];
        accessPreset?: string;
    }>;
};
export interface ControlAgentSettingsPort {
    decodeRevisionDocument(document: Record<string, unknown>): ControlAgentSettingsView;
    defaultSettings(): ControlAgentSettingsView;
    serializeRevisionDocument(settings: ControlAgentSettingsView): Record<string, unknown>;
    writeAgentHarnessSetting(input: {
        runtimeHome: string;
        appId: AppId;
        folder: string;
        name: string;
        agentHarness: AgentHarness;
    }): Promise<void>;
}
export interface ControlSettingsImportPort {
    serializeRevisionDocument(settings: ControlPlaneStorageSettings): Record<string, unknown>;
    importWorkstation(deps: Record<string, unknown>, settings: unknown): Promise<{
        status: 'revision_created';
        revision: number;
    } | {
        status: 'applied_no_revision';
    } | {
        status: 'no_op';
    }>;
    importFleet(deps: Record<string, unknown>, settings: unknown, options: {
        expectedRevision?: number | null;
        note?: string | null;
    }): Promise<{
        status: 'applied';
        revision: number;
    } | {
        status: 'invalid';
        errors: string[];
    } | {
        status: 'conflict';
        expectedRevision: number;
        actualRevision: number;
    }>;
    classifyImportError(error: unknown): {
        kind: 'stale';
    } | {
        kind: 'conflict';
        expectedRevision: number;
        actualRevision: number;
    } | null;
}
export interface ControlObserverStatus {
    enabled: boolean;
    activation: 'disabled' | 'configuration_required' | 'evidence_accumulating' | 'active';
    message: string;
    dreamingEnabled: boolean;
    owner: {
        recipient: string;
        conversation: string;
        conversationJid: string;
        providerAccountId: string;
    } | null;
}
export type ResolveControlObserverStatus = (appId: AppId) => Promise<ControlObserverStatus>;
export interface ControlObserverSettingsView {
    observer: {
        enabled: boolean;
        owner?: {
            recipient: string;
            conversation: string;
        };
    };
    providers: Record<string, {
        enabled: boolean;
    }>;
    providerAccounts: Record<string, {
        provider: string;
        status?: 'active' | 'disabled';
    }>;
    conversations: Record<string, {
        providerConnection?: string;
        providerAccount: string;
        externalId: string;
        kind: string;
        controlApprovers: string[];
    }>;
}
export declare function createResolveObserverStatus(input: {
    getEffectiveRuntimeSettings: () => EffectiveControlRuntimeSettings;
    getInternalRuntimeSettings: () => EffectiveControlRuntimeSettings;
    getEffectiveMemoryState: () => {
        enabled: boolean;
        dreamingEnabled: boolean;
    };
    conversations: ConversationRepository;
}): ResolveControlObserverStatus;
export declare function resolveControlObserverStatus(input: {
    appId: AppId;
    settings: ControlObserverSettingsView;
    memoryState: {
        enabled: boolean;
        dreamingEnabled: boolean;
    };
    conversations: ConversationRepository;
}): Promise<ControlObserverStatus>;
/**
 * Build the unified control-plane read model from runtime storage repositories.
 * Shared by the CLI (`gantry next`) and the MCP guided-action preview so both
 * derive the identical next action, including jobs, that the Control API already
 * derives via its injected request context.
 */
export declare function buildControlPlaneReadModelFromRepositories(input: {
    appId: AppId;
    settings: ControlPlaneStorageSettings;
    jobsRepository: Pick<RuntimeJobRepository, 'listJobs'>;
    jobControlRepository?: JobAppSessionLookupPort;
    modelCredentialsRepository: Pick<ModelCredentialRepository, 'listModelCredentials'>;
    pendingAccessRequestsRepository: {
        countPendingAccessRequests(input: {
            appId: AppId;
        }): Promise<number>;
    };
}): Promise<ControlPlaneReadModel>;

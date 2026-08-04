import type { AppId } from '../domain/app/app.js';
import { type AgentHarness } from '../shared/agent-engine.js';
import { getMemoryModelConfig } from './memory.js';
import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
import type { AgentRuntime, RuntimeSettings } from './settings/runtime-settings-types.js';
import { NO_PERMISSION_TIMEOUT_MS } from '../shared/permission-timeout.js';
export * from './memory.js';
export { SettingsDesiredStateService } from './settings/desired-state-service.js';
export { createGroupJoinOnboardingCoordinator } from './settings/group-join-onboarding.js';
export { configureDesiredSettingsStorageProvider } from './settings/runtime-settings.js';
export { applyRuntimeSettingsDesiredState, syncRuntimeSettingsFromProjection, } from './settings/restart-sync.js';
export { createDefaultRuntimeSettings, loadRuntimeSettings, loadRuntimeSettingsFromPath, } from './settings/runtime-settings.js';
export { resolveRuntimeBootstrapStorageConfigFromEnv, resolveRuntimeStorageConfig, resolveRuntimeStorageConfigFromSettings, } from './settings/storage.js';
export type { RuntimeSettings } from './settings/runtime-settings-types.js';
export type ControlEnvKey = 'GANTRY_CONTROL_API_KEYS_JSON' | 'GANTRY_CONTROL_HOST' | 'GANTRY_CONTROL_PORT' | 'GANTRY_CONTROL_SOCKET_PATH' | 'GANTRY_IPC_AUTH_SECRET' | 'GANTRY_SECURITY_POSTURE' | 'GANTRY_RUNTIME_ENV' | 'NODE_ENV' | 'REMOTE_CONTROL_AUTO_ACCEPT' | 'SECRET_ENCRYPTION_KEY' | 'SECRET_ENCRYPTION_KEYRING_JSON';
export declare function getControlEnvValue(key: ControlEnvKey): string;
export declare function readRuntimeSecretEnv(key: string): string;
export declare const GANTRY_HOME: string;
export declare const RUNTIME_SETTINGS_PATH: string;
export declare function getRuntimeSettingsForConfig(): RuntimeSettings;
export declare function getConfiguredAgentName(): string;
export declare const ASSISTANT_NAME: string;
export declare function getPublicRuntimeSettings(): {
    desiredState: import("./settings/runtime-settings-types.js").RuntimeDesiredStateSettings;
    agent: {
        name: string;
        defaultModel: string;
        agentHarness: "auto" | "deepagents" | "anthropic_sdk";
        oneTimeJobDefaultModel: string;
        recurringJobDefaultModel: string;
    };
    agents: {
        [k: string]: {
            name: string;
            folder: string;
            persona: "developer" | "generalist" | "sales" | "marketing" | "operations" | "research" | undefined;
            relationshipMode: "personal" | "organization" | undefined;
            runtime: AgentRuntime;
            model: string | undefined;
            agentHarness: "auto" | "deepagents" | "anthropic_sdk" | undefined;
            permissionMode: import("../shared/permission-mode.js").PermissionMode | undefined;
            oneTimeJobDefaultModel: string | undefined;
            recurringJobDefaultModel: string | undefined;
            delegates: string[];
            bindings: Record<string, import("./settings/runtime-settings-types.js").RuntimeConfiguredAgentBinding>;
            sources: import("./settings/runtime-settings-types.js").RuntimeConfiguredAgentSources;
            capabilities: import("./settings/runtime-settings-types.js").RuntimeConfiguredAgentCapability[];
            access: {
                preset: import("./settings/runtime-settings-types.js").AgentAccessPreset;
            };
        };
    };
    providers: Record<string, import("./settings/runtime-settings-types.js").RuntimeProviderSettings>;
    providerAccounts: Record<string, import("./settings/runtime-settings-types.js").RuntimeProviderAccountSettings>;
    conversations: {
        [k: string]: {
            brainHarvest: boolean;
            providerAccount: string;
            externalId: string;
            kind: import("./settings/runtime-settings-types.js").RuntimeConversationKind;
            displayName: string;
            senderPolicy: import("./settings/sender-allowlist.js").ChatAllowlistEntry;
            controlApprovers: string[];
            installedAgents: Record<string, import("./settings/runtime-settings-types.js").RuntimeConfiguredConversationInstall>;
        };
    };
    conversationInstalls: Record<string, import("./settings/runtime-settings-types.js").RuntimeConfiguredConversationInstall & {
        conversationId: string;
    }>;
    bindings: Record<string, import("./settings/runtime-settings-types.js").RuntimeConfiguredBinding>;
    modelAliases: Record<string, import("./settings/runtime-settings-types.js").RuntimeCustomModelAlias>;
    memory: {
        enabled: boolean;
        dreaming: {
            enabled: boolean;
        };
    };
    observer: import("./settings/runtime-settings-types.js").RuntimeObserverSettings;
    runtime: {
        queue: import("./settings/runtime-settings-types.js").RuntimeQueueSettings;
        sandbox: import("./settings/runtime-settings-types.js").RuntimeSandboxSettings;
        artifactStore: import("./settings/runtime-settings-types.js").RuntimeArtifactStoreSettings;
        deploymentMode: RuntimeDeploymentMode;
    };
    browser: {
        usage: {
            enabled: boolean;
            mode: import("./settings/runtime-settings-types.js").RuntimeBrowserUsagePolicyMode;
            windowMs: number;
            maxActionsPerWindow: number;
            maxConcurrentPerSite: number;
        };
    };
    permissions: {
        yoloMode: import("../shared/yolo-mode-policy.js").YoloModeSettings;
        egress: import("../shared/egress-policy.js").EgressSettings;
        autoMode: {
            model?: string;
        };
    };
};
export declare function getDeploymentMode(): RuntimeDeploymentMode;
export declare function getRuntimeQueueConfig(): {
    maxMessageRuns: number;
    maxJobRuns: number;
    maxMessageBacklog: number;
    maxLiveAdmissionBacklog: number;
    maxTaskBacklog: number;
    maxRetries: number;
    baseRetryMs: number;
    drainDeadlineMs: number;
};
export declare const STORE_DIR: string;
export declare const AGENTS_DIR: string;
export declare const DATA_DIR: string;
export declare const ARTIFACTS_DIR: string;
export declare const STORAGE_POSTGRES_URL_ENV: string;
export declare const STORAGE_POSTGRES_URL: string | null;
export declare const STORAGE_POSTGRES_SCHEMA: string;
export declare const STORAGE_POSTGRES_PLAINTEXT_HOST_ALLOWLIST: readonly string[] | undefined;
export declare const PERMISSION_APPROVAL_TIMEOUT_MS: number;
export { NO_PERMISSION_TIMEOUT_MS };
export declare const AGENT_TIMEOUT: number;
export declare const AGENT_MAX_OUTPUT_SIZE: number;
export declare function getCredentialBrokerRuntimeConfig(): {
    mode: RuntimeSettings['credentialBroker']['mode'];
    gatewayBindHost: string;
};
export declare const SECRET_ENCRYPTION_KEY: string;
export declare function getConfiguredDefaultModel(): string;
export declare const GANTRY_IPC_AUTH_SECRET: string;
export declare const LOG_LEVEL: string;
export declare const HOST_CREDENTIAL_ENV_KEYS: readonly ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
type HostCredentialSource = Partial<Record<string, string | undefined>>;
export declare function getHostCredentialEnv(source?: HostCredentialSource): Record<string, string>;
export type ClaudeAuthMode = 'broker' | 'none';
export interface ClaudeAuthState {
    hasOauthToken: boolean;
    hasApiKey: boolean;
    mode: ClaudeAuthMode;
}
export declare function resolveClaudeAuthState(): ClaudeAuthState;
export declare function getMemoryModelRuntimeConfig(): ReturnType<typeof getMemoryModelConfig>;
export type DefaultModelSource = 'settings.yaml agents.<agent>.model' | 'settings.yaml agents.<agent>.one_time_job_default_model' | 'settings.yaml agents.<agent>.recurring_job_default_model' | 'settings.yaml agent.default_model' | 'system default';
export type EffectiveModelSource = 'conversation.agentConfig.model' | 'job.model' | 'settings.yaml agent.one_time_job_default_model' | 'settings.yaml agent.recurring_job_default_model' | DefaultModelSource;
export type ModelUseKind = 'interactive' | 'oneTimeJob' | 'recurringJob';
export declare function getDefaultModelConfig(kind?: ModelUseKind, agentFolder?: string): {
    model?: string;
    source: DefaultModelSource;
} | {
    model?: string;
    source: 'settings.yaml agents.<agent>.one_time_job_default_model' | 'settings.yaml agents.<agent>.recurring_job_default_model' | 'settings.yaml agent.one_time_job_default_model' | 'settings.yaml agent.recurring_job_default_model';
};
export declare function getRuntimeModelDefaults(): import("./settings/model-defaults.js").RuntimeModelDefaults;
export declare function patchRuntimeModelDefaults(body: Record<string, unknown>, appId?: AppId, createdBy?: string, options?: {
    getConfiguredModelProviderIds?: () => Promise<ReadonlySet<string>>;
}): Promise<import("./settings/model-defaults.js").RuntimeModelDefaultsPatchResult>;
export declare function getEffectiveModelConfig(groupModel?: string, kind?: ModelUseKind, agentFolder?: string): {
    model?: string;
    source: EffectiveModelSource;
};
export declare function getSelectedAgentHarness(agentFolder?: string): AgentHarness;
export declare function getSelectedAgentRuntime(agentFolder?: string): AgentRuntime;
export declare function getSelectedAgentPermissionMode(agentFolder?: string): import("../shared/permission-mode.js").PermissionMode;
export declare function getConfiguredAgentRuntime(agentFolder?: string): AgentRuntime | undefined;
export declare const MESSAGE_FETCH_PAGE_SIZE: number;
export declare const MAX_MESSAGES_PER_PROMPT: number;
export declare const IPC_POLL_INTERVAL = 1000;
export declare const IDLE_TIMEOUT: number;
export declare const DEFAULT_TRIGGER: string;
export declare function getTriggerPattern(trigger?: string): RegExp;
export declare const TRIGGER_PATTERN: RegExp;
export declare const TIMEZONE: string;

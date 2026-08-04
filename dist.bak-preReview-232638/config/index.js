import path from 'path';
import fs from 'fs';
import { resolveModelAlias } from '../shared/model-catalog.js';
import { AUTO_AGENT_HARNESS, } from '../shared/agent-engine.js';
import { envConfig, envValue, envValueDynamic } from './env/index.js';
import { getMemoryModelConfig } from './memory.js';
import { getGantryHome } from '../shared/gantry-home.js';
import { resolveRuntimeStorageConfig } from './settings/storage.js';
import { ensureRuntimeSettings } from './settings/runtime-settings.js';
import { readRuntimeModelDefaults, updateRuntimeModelDefaults, } from './settings/model-defaults.js';
import { settingsFilePath } from './settings/runtime-home.js';
import { DEFAULT_AGENT_NAME } from './settings/runtime-settings-defaults.js';
import { resolveConfiguredAgentRuntime } from './settings/runtime-settings-agent-runtime.js';
import { isValidTimezone } from '../shared/timezone.js';
import { NO_PERMISSION_TIMEOUT_MS, resolvePermissionApprovalTimeoutMs, } from '../shared/permission-timeout.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';
import { buildTriggerPattern, defaultTriggerForAgentName, } from '../shared/trigger-pattern.js';
export * from './memory.js';
export { SettingsDesiredStateService } from './settings/desired-state-service.js';
export { createGroupJoinOnboardingCoordinator } from './settings/group-join-onboarding.js';
export { configureDesiredSettingsStorageProvider } from './settings/runtime-settings.js';
export { applyRuntimeSettingsDesiredState, syncRuntimeSettingsFromProjection, } from './settings/restart-sync.js';
export { createDefaultRuntimeSettings, loadRuntimeSettings, loadRuntimeSettingsFromPath, } from './settings/runtime-settings.js';
export { resolveRuntimeBootstrapStorageConfigFromEnv, resolveRuntimeStorageConfig, resolveRuntimeStorageConfigFromSettings, } from './settings/storage.js';
export function getControlEnvValue(key) {
    return envValueDynamic(key);
}
// Registered runtime secrets (source-classification.ts) read from process env
// first, then GANTRY_HOME/.env — managed services pass a minimal process env.
export function readRuntimeSecretEnv(key) {
    return envValueDynamic(key);
}
const GANTRY_HOME_RAW = process.env.GANTRY_HOME?.trim() || envConfig.GANTRY_HOME?.trim() || '';
export const GANTRY_HOME = getGantryHome(GANTRY_HOME_RAW);
export const RUNTIME_SETTINGS_PATH = settingsFilePath(GANTRY_HOME);
const RUNTIME_ROOT = GANTRY_HOME;
let runtimeSettingsCache;
export function getRuntimeSettingsForConfig() {
    const filePath = settingsFilePath(GANTRY_HOME);
    try {
        const stat = fs.statSync(filePath);
        if (runtimeSettingsCache?.filePath === filePath &&
            runtimeSettingsCache.mtimeMs === stat.mtimeMs &&
            runtimeSettingsCache.size === stat.size) {
            return runtimeSettingsCache.settings;
        }
        const settings = ensureRuntimeSettings(GANTRY_HOME);
        runtimeSettingsCache = {
            filePath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            settings,
        };
        return settings;
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
        const settings = ensureRuntimeSettings(GANTRY_HOME);
        const stat = fs.statSync(filePath);
        runtimeSettingsCache = {
            filePath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            settings,
        };
        return settings;
    }
}
export function getConfiguredAgentName() {
    try {
        return (getRuntimeSettingsForConfig().agent.name.trim() || DEFAULT_AGENT_NAME);
    }
    catch {
        return DEFAULT_AGENT_NAME;
    }
}
export const ASSISTANT_NAME = getConfiguredAgentName();
function getPublicConfiguredAgents(settings) {
    return Object.fromEntries(Object.entries(settings.agents).map(([agentId, agent]) => [
        agentId,
        {
            name: agent.name,
            folder: agent.folder,
            persona: agent.persona,
            relationshipMode: agent.relationshipMode,
            runtime: resolveConfiguredAgentRuntime(agent),
            model: agent.model,
            agentHarness: agent.agentHarness,
            permissionMode: agent.permissionMode,
            oneTimeJobDefaultModel: agent.oneTimeJobDefaultModel,
            recurringJobDefaultModel: agent.recurringJobDefaultModel,
            delegates: agent.delegates,
            bindings: agent.bindings,
            sources: agent.sources,
            capabilities: agent.capabilities,
            access: {
                preset: agent.accessPreset,
            },
        },
    ]));
}
function getPublicConfiguredConversations(settings) {
    return Object.fromEntries(Object.entries(settings.conversations).map(([conversationId, entry]) => {
        const { providerConnection: _providerConnection, ...conversation } = entry;
        return [
            conversationId,
            { ...conversation, brainHarvest: conversation.brainHarvest ?? false },
        ];
    }));
}
export function getPublicRuntimeSettings() {
    const settings = getRuntimeSettingsForConfig();
    return {
        desiredState: settings.desiredState,
        agent: {
            name: settings.agent.name,
            defaultModel: settings.agent.defaultModel,
            agentHarness: settings.agent.agentHarness,
            oneTimeJobDefaultModel: settings.agent.oneTimeJobDefaultModel,
            recurringJobDefaultModel: settings.agent.recurringJobDefaultModel,
        },
        agents: getPublicConfiguredAgents(settings),
        providers: settings.providers,
        providerAccounts: settings.providerAccounts,
        conversations: getPublicConfiguredConversations(settings),
        conversationInstalls: settings.conversationInstalls,
        bindings: settings.bindings,
        modelAliases: settings.modelAliases,
        memory: {
            enabled: settings.memory.enabled,
            dreaming: {
                enabled: settings.memory.dreaming.enabled,
            },
        },
        observer: settings.observer,
        runtime: {
            queue: settings.runtime.queue,
            sandbox: settings.runtime.sandbox,
            artifactStore: settings.runtime.artifactStore,
            deploymentMode: settings.runtime.deploymentMode,
        },
        browser: {
            usage: {
                enabled: settings.browser.usage.enabled,
                mode: settings.browser.usage.mode,
                windowMs: settings.browser.usage.windowMs,
                maxActionsPerWindow: settings.browser.usage.maxActionsPerWindow,
                maxConcurrentPerSite: settings.browser.usage.maxConcurrentPerSite,
            },
        },
        permissions: {
            yoloMode: effectiveYoloModeSettings(settings.permissions.yoloMode),
            egress: settings.permissions.egress,
            autoMode: settings.permissions.autoMode,
        },
    };
}
export function getDeploymentMode() {
    return getRuntimeSettingsForConfig().runtime.deploymentMode;
}
export function getRuntimeQueueConfig() {
    const queue = getRuntimeSettingsForConfig().runtime.queue;
    return {
        maxMessageRuns: queue.maxMessageRuns,
        maxJobRuns: queue.maxJobRuns,
        maxMessageBacklog: queue.maxMessageBacklog,
        maxLiveAdmissionBacklog: queue.maxLiveAdmissionBacklog,
        maxTaskBacklog: queue.maxTaskBacklog,
        maxRetries: queue.maxRetries,
        baseRetryMs: queue.baseRetryMs,
        drainDeadlineMs: queue.drainDeadlineMs,
    };
}
export const STORE_DIR = path.resolve(RUNTIME_ROOT, 'store');
export const AGENTS_DIR = path.resolve(RUNTIME_ROOT, 'agents');
export const DATA_DIR = path.resolve(RUNTIME_ROOT, 'data');
export const ARTIFACTS_DIR = path.resolve(RUNTIME_ROOT, 'artifacts');
const runtimeStorageConfig = resolveRuntimeStorageConfig(GANTRY_HOME, RUNTIME_ROOT);
export const STORAGE_POSTGRES_URL_ENV = runtimeStorageConfig.postgresUrlEnv;
export const STORAGE_POSTGRES_URL = runtimeStorageConfig.postgresUrl;
export const STORAGE_POSTGRES_SCHEMA = runtimeStorageConfig.postgresSchema;
export const STORAGE_POSTGRES_PLAINTEXT_HOST_ALLOWLIST = runtimeStorageConfig.postgresPlaintextHostAllowlist;
export const PERMISSION_APPROVAL_TIMEOUT_MS = resolvePermissionApprovalTimeoutMs(process.env, envConfig);
export { NO_PERMISSION_TIMEOUT_MS };
export const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '1800000', 10);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(process.env.AGENT_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export function getCredentialBrokerRuntimeConfig() {
    const settings = getRuntimeSettingsForConfig();
    return {
        mode: settings.credentialBroker.mode,
        gatewayBindHost: settings.credentialBroker.gateway.bindHost,
    };
}
export const SECRET_ENCRYPTION_KEY = envValue('SECRET_ENCRYPTION_KEY');
const normModel = resolveModelAlias;
export function getConfiguredDefaultModel() {
    return normModel(getRuntimeSettingsForConfig().agent.defaultModel) || '';
}
export const GANTRY_IPC_AUTH_SECRET = envValue('GANTRY_IPC_AUTH_SECRET');
export const LOG_LEVEL = envValue('LOG_LEVEL') || 'info';
export const HOST_CREDENTIAL_ENV_KEYS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
function readHostCredentialValue(key, source) {
    return source?.[key]?.trim() || '';
}
export function getHostCredentialEnv(source) {
    const env = {};
    for (const key of HOST_CREDENTIAL_ENV_KEYS) {
        const value = readHostCredentialValue(key, source);
        if (value)
            env[key] = value;
    }
    return env;
}
export function resolveClaudeAuthState() {
    const brokerConfig = getCredentialBrokerRuntimeConfig();
    const credentialMode = brokerConfig.mode;
    return {
        hasOauthToken: false,
        hasApiKey: false,
        mode: credentialMode === 'gantry' ? 'broker' : 'none',
    };
}
export function getMemoryModelRuntimeConfig() {
    return getMemoryModelConfig(getConfiguredDefaultModel());
}
export function getDefaultModelConfig(kind = 'interactive', agentFolder) {
    const settings = getRuntimeSettingsForConfig();
    const configuredAgent = agentFolder
        ? settings.agents[agentFolder]
        : undefined;
    if (kind === 'oneTimeJob') {
        const oneTimeAgentModel = normModel(configuredAgent?.oneTimeJobDefaultModel);
        if (oneTimeAgentModel) {
            return {
                model: oneTimeAgentModel,
                source: 'settings.yaml agents.<agent>.one_time_job_default_model',
            };
        }
        const oneTimeModel = normModel(settings.agent.oneTimeJobDefaultModel);
        if (oneTimeModel) {
            return {
                model: oneTimeModel,
                source: 'settings.yaml agent.one_time_job_default_model',
            };
        }
    }
    if (kind === 'recurringJob') {
        const recurringAgentModel = normModel(configuredAgent?.recurringJobDefaultModel);
        if (recurringAgentModel) {
            return {
                model: recurringAgentModel,
                source: 'settings.yaml agents.<agent>.recurring_job_default_model',
            };
        }
        const recurringModel = normModel(settings.agent.recurringJobDefaultModel);
        if (recurringModel) {
            return {
                model: recurringModel,
                source: 'settings.yaml agent.recurring_job_default_model',
            };
        }
    }
    const configuredAgentModel = normModel(configuredAgent?.model);
    if (configuredAgentModel) {
        return {
            model: configuredAgentModel,
            source: 'settings.yaml agents.<agent>.model',
        };
    }
    const configuredModel = normModel(settings.agent.defaultModel) || '';
    if (configuredModel) {
        return {
            model: configuredModel,
            source: 'settings.yaml agent.default_model',
        };
    }
    return { model: 'opus', source: 'system default' };
}
export function getRuntimeModelDefaults() {
    return readRuntimeModelDefaults({
        runtimeHome: GANTRY_HOME,
        getDefaultModelConfig,
    });
}
export function patchRuntimeModelDefaults(body, appId, createdBy, options) {
    return updateRuntimeModelDefaults({
        runtimeHome: GANTRY_HOME,
        body,
        appId,
        createdBy,
        getConfiguredModelProviderIds: options?.getConfiguredModelProviderIds,
    });
}
export function getEffectiveModelConfig(groupModel, kind = 'interactive', agentFolder) {
    const normalizedGroupModel = normModel(groupModel);
    if (normalizedGroupModel) {
        return {
            model: normalizedGroupModel,
            source: 'conversation.agentConfig.model',
        };
    }
    return getDefaultModelConfig(kind, agentFolder);
}
export function getSelectedAgentHarness(agentFolder) {
    const settings = getRuntimeSettingsForConfig();
    const configuredAgent = agentFolder
        ? settings.agents[agentFolder]
        : undefined;
    return (configuredAgent?.agentHarness ??
        settings.agent.agentHarness ??
        AUTO_AGENT_HARNESS);
}
export function getSelectedAgentRuntime(agentFolder) {
    return getConfiguredAgentRuntime(agentFolder) ?? 'worker';
}
export function getSelectedAgentPermissionMode(agentFolder) {
    const agent = agentFolder
        ? getRuntimeSettingsForConfig().agents[agentFolder]
        : undefined;
    return resolveEffectivePermissionMode(undefined, agent?.permissionMode);
}
export function getConfiguredAgentRuntime(agentFolder) {
    const settings = getRuntimeSettingsForConfig();
    const configuredAgent = agentFolder
        ? settings.agents[agentFolder]
        : undefined;
    if (!configuredAgent)
        return undefined;
    return resolveConfiguredAgentRuntime(configuredAgent);
}
export const MESSAGE_FETCH_PAGE_SIZE = Math.max(1, parseInt(process.env.MESSAGE_FETCH_PAGE_SIZE || '200', 10) || 200);
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep the agent run alive after last result
export const DEFAULT_TRIGGER = defaultTriggerForAgentName(ASSISTANT_NAME);
export function getTriggerPattern(trigger) {
    const normalizedTrigger = trigger?.trim();
    return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}
export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);
// Timezone for scheduler jobs, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone() {
    const candidates = [
        process.env.TZ,
        envConfig.TZ,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    ];
    for (const tz of candidates) {
        if (tz && isValidTimezone(tz))
            return tz;
    }
    return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

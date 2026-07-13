import {
  AUTO_AGENT_HARNESS,
  isAgentHarness,
  type AgentHarness,
} from '../../shared/agent-engine.js';
import {
  getProvider,
  listChannelProviders,
  normalizeProviderId,
} from '../../channels/provider-registry.js';
import {
  resolveModelSelectionForWorkload,
  withCustomModelCatalogEntries,
} from '../../shared/model-catalog.js';
import { parseSenderAllowlistConfig } from './sender-allowlist.js';
import { parseSimpleYamlObject } from './yaml.js';
import { normalizeCompactRuntimeSettingsRoot } from './runtime-settings-compact.js';
import {
  parseConfiguredAgents,
  parseDesiredStateSettings,
} from './runtime-settings-agents-parser.js';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS,
  DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT,
  DEFAULT_MODEL_GATEWAY_BIND_HOST,
  DEFAULT_STORAGE_POSTGRES_SCHEMA,
  DEFAULT_STORAGE_POSTGRES_URL_ENV,
  getDefaultRuntimeSandboxSettings,
} from './runtime-settings-defaults.js';
import type {
  RuntimeArtifactStoreSettings,
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeConfiguredConversationInstall,
  RuntimeConfiguredConversation,
  RuntimeProviderAccountSettings,
  RuntimeProcessSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';
import type { ChatAllowlistEntry } from './sender-allowlist.js';
import { parseMemorySettings } from './runtime-settings-memory-parser.js';
import { parseBrowserSettings } from './runtime-settings-browser-parser.js';
import { parsePermissionSettings } from './runtime-settings-permissions-parser.js';
import { parseLimitsSettings } from './runtime-settings-limits-parser.js';
import { parseObservabilitySettings } from './runtime-settings-observability-parser.js';
import { parseModelFamilies } from './runtime-settings-model-families-parser.js';
import {
  modelAliasesToCatalogEntries,
  parseModelAliases,
} from './runtime-settings-model-aliases-parser.js';
import { parseProviderAccounts } from './runtime-settings-provider-accounts-parser.js';
import {
  deriveAgentBindingsFromDesiredState,
  deriveBindingsFromConversationInstalls,
  flattenConversationInstalls,
} from './runtime-settings-binding-derivation.js';
import {
  parseBooleanValue,
  parseNonNegativeIntegerValue,
  parseOptionalStringValue,
  parsePositiveIntegerValue,
  parseStringArrayValue,
  parseStringValue,
} from './runtime-settings-parse-primitives.js';
import { jidForConfiguredConversation } from './desired-state-provider-conversations.js';

function parseAgentHarnessValue(
  raw: unknown,
  pathPrefix: string,
  fallback: AgentHarness = AUTO_AGENT_HARNESS,
): AgentHarness {
  if (raw === undefined) return fallback;
  if (!isAgentHarness(raw)) {
    throw new Error(
      `${pathPrefix} must be one of auto, anthropic_sdk, or deepagents`,
    );
  }
  return raw;
}

function parseProviderSettings(
  raw: unknown,
): Record<string, RuntimeProviderSettings> {
  const providers = Object.fromEntries(
    listChannelProviders().map((provider) => [provider.id, { enabled: false }]),
  ) as Record<string, RuntimeProviderSettings>;
  if (raw === undefined) return providers;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('providers must be a mapping');
  }
  for (const [providerId, providerRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!getProvider(providerId)) {
      throw new Error(`providers.${providerId} is not a supported provider`);
    }
    if (
      typeof providerRaw !== 'object' ||
      providerRaw === null ||
      Array.isArray(providerRaw)
    ) {
      throw new Error(`providers.${providerId} must be a mapping`);
    }
    const map = providerRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (key !== 'enabled') {
        throw new Error(
          `providers.${providerId}.${key} is not supported. Configure enabled. Provider Accounts live under provider_accounts.`,
        );
      }
    }
    providers[providerId] = {
      enabled: parseBooleanValue(
        map.enabled,
        `providers.${providerId}.enabled`,
      ),
    };
  }
  return providers;
}

function parseSenderPolicy(
  raw: unknown,
  pathPrefix: string,
): ChatAllowlistEntry {
  const parsed = parseSenderAllowlistConfig(
    {
      default: raw ?? { allow: '*', mode: 'trigger' },
      agents: {},
      log_denied: true,
    },
    pathPrefix,
  );
  return parsed.default;
}

function parseConversationKind(raw: unknown, pathPrefix: string) {
  const value = parseStringValue(raw, pathPrefix);
  if (
    value === 'dm' ||
    value === 'direct' ||
    value === 'group' ||
    value === 'channel' ||
    value === 'chat' ||
    value === 'service' ||
    value === 'web'
  ) {
    return value;
  }
  throw new Error(
    `${pathPrefix} must be one of dm, direct, group, channel, chat, service, web`,
  );
}

function parseConversations(
  raw: unknown,
  providerAccounts: Record<string, RuntimeProviderAccountSettings>,
): Record<string, RuntimeConfiguredConversation> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('conversations must be a mapping');
  }
  const conversations: Record<string, RuntimeConfiguredConversation> = {};
  const seenExternal = new Set<string>();
  for (const [conversationId, conversationRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const pathPrefix = `conversations.${conversationId}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(conversationId)) {
      throw new Error(`${pathPrefix} must use a stable conversation id`);
    }
    if (
      typeof conversationRaw !== 'object' ||
      conversationRaw === null ||
      Array.isArray(conversationRaw)
    ) {
      throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = conversationRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'provider_account' &&
        key !== 'external_id' &&
        key !== 'id' &&
        key !== 'kind' &&
        key !== 'type' &&
        key !== 'display_name' &&
        key !== 'brain_harvest' &&
        key !== 'sender_policy' &&
        key !== 'control_approvers' &&
        key !== 'installed_agents'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure provider_account, external_id, kind, display_name, brain_harvest, sender_policy, control_approvers, or installed_agents.`,
        );
      }
    }
    const kind = parseConversationKind(
      map.kind ?? map.type,
      `${pathPrefix}.kind`,
    );
    const installedAgents = parseConversationInstalledAgents(
      map.installed_agents,
      `${pathPrefix}.installed_agents`,
      providerAccounts,
      kind !== 'direct' && kind !== 'dm',
    );
    const providerAccount = parseStringValue(
      map.provider_account,
      `${pathPrefix}.provider_account`,
      Object.values(installedAgents)[0]?.providerAccountId,
    );
    const account = providerAccounts[providerAccount];
    if (!account) {
      throw new Error(
        `${pathPrefix}.provider_account references unknown provider account ${providerAccount}`,
      );
    }
    const externalId = parseStringValue(
      map.external_id ?? map.id,
      `${pathPrefix}.external_id`,
    );
    assertExternalIdProviderPrefixMatchesConnection({
      externalId,
      providerId: account.provider,
      pathPrefix: `${pathPrefix}.external_id`,
    });
    const externalKey = `${providerAccount}:${externalId}`;
    if (seenExternal.has(externalKey)) {
      throw new Error(`${pathPrefix}.external_id duplicates ${externalKey}`);
    }
    seenExternal.add(externalKey);
    conversations[conversationId] = {
      providerConnection: providerAccount,
      providerAccount,
      externalId,
      kind,
      displayName: parseStringValue(
        map.display_name,
        `${pathPrefix}.display_name`,
        conversationId,
      ),
      brainHarvest: parseBooleanValue(
        map.brain_harvest,
        `${pathPrefix}.brain_harvest`,
        false,
      ),
      senderPolicy: parseSenderPolicy(
        map.sender_policy,
        `${pathPrefix}.sender_policy`,
      ),
      controlApprovers: parseStringArrayValue(
        map.control_approvers ?? [],
        `${pathPrefix}.control_approvers`,
      ),
      installedAgents,
    };
  }
  return conversations;
}

function parseConversationInstalledAgents(
  raw: unknown,
  pathPrefix: string,
  providerAccounts: Record<string, RuntimeProviderAccountSettings>,
  defaultRequiresTrigger: boolean,
): Record<string, RuntimeConfiguredConversationInstall> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const installs: Record<string, RuntimeConfiguredConversationInstall> = {};
  for (const [installId, installRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const installPath = `${pathPrefix}.${installId}`;
    if (
      typeof installRaw !== 'object' ||
      installRaw === null ||
      Array.isArray(installRaw)
    ) {
      throw new Error(`${installPath} must be a mapping`);
    }
    const map = installRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'provider_account' &&
        key !== 'agent' &&
        key !== 'agent_id' &&
        key !== 'thread_id' &&
        key !== 'status' &&
        key !== 'added_at' &&
        key !== 'memory_scope' &&
        key !== 'trigger' &&
        key !== 'requires_trigger' &&
        key !== 'model' &&
        key !== 'permission_mode'
      ) {
        throw new Error(
          `${installPath}.${key} is not supported. Configure provider_account, agent, thread_id, status, added_at, memory_scope, trigger, requires_trigger, model, or permission_mode.`,
        );
      }
    }
    const agentId = parseStringValue(
      map.agent_id ?? map.agent,
      `${installPath}.agent`,
      installId,
    );
    const providerAccountId = parseStringValue(
      map.provider_account,
      `${installPath}.provider_account`,
    );
    const account = providerAccounts[providerAccountId];
    if (!account) {
      throw new Error(
        `${installPath}.provider_account references unknown provider account ${providerAccountId}`,
      );
    }
    if (account.agentId !== agentId) {
      throw new Error(
        `${installPath}.provider_account belongs to ${account.agentId}, not ${agentId}`,
      );
    }
    const status = parseStringValue(
      map.status,
      `${installPath}.status`,
      'active',
    );
    if (status !== 'active' && status !== 'disabled') {
      throw new Error(`${installPath}.status must be active or disabled`);
    }
    const memoryScope = parseStringValue(
      map.memory_scope,
      `${installPath}.memory_scope`,
      'conversation',
    );
    if (
      memoryScope !== 'conversation' &&
      memoryScope !== 'user' &&
      memoryScope !== 'agent' &&
      memoryScope !== 'app'
    ) {
      throw new Error(
        `${installPath}.memory_scope must be conversation, user, agent, or app`,
      );
    }
    const model =
      map.model === undefined
        ? undefined
        : typeof map.model === 'string' && map.model.trim() === ''
          ? undefined
          : parseStringValue(map.model, `${installPath}.model`);
    if (model) {
      const resolved = resolveModelSelectionForWorkload(model, 'chat');
      if (!resolved.ok) {
        throw new Error(`${installPath}.model is invalid: ${resolved.message}`);
      }
    }
    const permissionMode = map.permission_mode;
    if (
      permissionMode !== undefined &&
      permissionMode !== 'ask' &&
      permissionMode !== 'auto' &&
      permissionMode !== 'auto_strict'
    ) {
      throw new Error(
        `${installPath}.permission_mode must be one of ask, auto, or auto_strict`,
      );
    }
    installs[installId] = {
      agentId,
      providerAccountId,
      threadId:
        map.thread_id === undefined
          ? undefined
          : parseStringValue(map.thread_id, `${installPath}.thread_id`),
      status,
      addedAt: parseStringValue(
        map.added_at,
        `${installPath}.added_at`,
        new Date(0).toISOString(),
      ),
      memoryScope,
      trigger: parseOptionalStringValue(map.trigger, `${installPath}.trigger`),
      requiresTrigger: parseBooleanValue(
        map.requires_trigger,
        `${installPath}.requires_trigger`,
        defaultRequiresTrigger,
      ),
      model,
      permissionMode,
    };
  }
  return installs;
}

function assertExternalIdProviderPrefixMatchesConnection(input: {
  externalId: string;
  providerId: string;
  pathPrefix: string;
}): void {
  const explicitProviderId = explicitProviderIdForExternalId(input.externalId);
  if (!explicitProviderId) return;
  const normalizedConnectionProviderId = normalizeProviderId(input.providerId);
  if (!normalizedConnectionProviderId) return;
  if (explicitProviderId === normalizedConnectionProviderId) return;
  throw new Error(
    `${input.pathPrefix} uses explicit provider prefix "${explicitProviderId}:" that does not match provider connection "${normalizedConnectionProviderId}".`,
  );
}

function explicitProviderIdForExternalId(value: string): string | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const explicitProviderId = normalizeProviderId(value.slice(0, separator));
  return explicitProviderId || null;
}

function parsePostgresSchema(
  raw: unknown,
  pathPrefix: string,
  fallback = DEFAULT_STORAGE_POSTGRES_SCHEMA,
): string {
  const value = parseStringValue(raw, pathPrefix, fallback);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(
      `${pathPrefix} must be a lowercase PostgreSQL schema identifier`,
    );
  }
  return value;
}

function parseModelAccessSettings(
  raw: unknown,
): RuntimeCredentialBrokerSettings {
  const defaultSettings: RuntimeCredentialBrokerSettings = {
    mode: 'gantry',
    gateway: {
      bindHost: DEFAULT_MODEL_GATEWAY_BIND_HOST,
    },
  };
  if (raw === undefined) return defaultSettings;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('model_access must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'enabled' && key !== 'gateway') {
      throw new Error(
        `model_access.${key} is not supported. Configure model_access.enabled or gateway.*.`,
      );
    }
  }
  const enabled =
    map.enabled === undefined
      ? defaultSettings.mode === 'gantry'
      : parseBooleanValue(map.enabled, 'model_access.enabled');
  const gatewayRaw = map.gateway;
  if (
    gatewayRaw !== undefined &&
    (typeof gatewayRaw !== 'object' ||
      gatewayRaw === null ||
      Array.isArray(gatewayRaw))
  ) {
    throw new Error('model_access.gateway must be a mapping');
  }
  const gateway = (gatewayRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(gateway)) {
    if (key !== 'bind_host') {
      throw new Error(
        `model_access.gateway.${key} is not supported. Configure bind_host.`,
      );
    }
  }

  return {
    mode: enabled ? 'gantry' : 'none',
    gateway: {
      bindHost: parseGatewayBindHost(gateway.bind_host),
    },
  };
}

function parseGatewayBindHost(raw: unknown): string {
  const value = parseStringValue(
    raw,
    'model_access.gateway.bind_host',
    DEFAULT_MODEL_GATEWAY_BIND_HOST,
  ).toLowerCase();
  // Numeric loopback only: the gateway broker crashes at startup otherwise.
  if (value === '127.0.0.1' || value === '::1') {
    return value;
  }
  throw new Error(
    'model_access.gateway.bind_host must be a numeric loopback host: 127.0.0.1 or ::1.',
  );
}

function parseAgentSettings(raw: unknown): RuntimeAgentSettings {
  if (raw === undefined) {
    return {
      name: DEFAULT_AGENT_NAME,
      defaultModel: '',
      agentHarness: AUTO_AGENT_HARNESS,
      oneTimeJobDefaultModel: '',
      recurringJobDefaultModel: '',
      sessions: {
        memoryItemLimit: DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT,
        maxMemoryContextChars: DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS,
      },
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agent must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'name' &&
      key !== 'default_model' &&
      key !== 'agent_harness' &&
      key !== 'one_time_job_default_model' &&
      key !== 'recurring_job_default_model' &&
      key !== 'sessions'
    ) {
      throw new Error(
        `agent.${key} is not supported. Configure agent.name, agent.default_model, agent.agent_harness, agent.one_time_job_default_model, agent.recurring_job_default_model, or agent.sessions.*.`,
      );
    }
  }
  const sessionsRaw = map.sessions;
  if (
    sessionsRaw !== undefined &&
    (typeof sessionsRaw !== 'object' ||
      sessionsRaw === null ||
      Array.isArray(sessionsRaw))
  ) {
    throw new Error('agent.sessions must be a mapping');
  }
  const sessions = (sessionsRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(sessions)) {
    if (key !== 'memory_item_limit' && key !== 'max_memory_context_chars') {
      throw new Error(
        `agent.sessions.${key} is not supported. Configure memory_item_limit or max_memory_context_chars.`,
      );
    }
  }
  return {
    name: parseStringValue(map.name, 'agent.name', DEFAULT_AGENT_NAME),
    defaultModel:
      map.default_model === undefined
        ? ''
        : typeof map.default_model === 'string'
          ? map.default_model.trim()
          : parseStringValue(map.default_model, 'agent.default_model'),
    agentHarness: parseAgentHarnessValue(
      map.agent_harness,
      'agent.agent_harness',
    ),
    oneTimeJobDefaultModel:
      map.one_time_job_default_model === undefined
        ? ''
        : typeof map.one_time_job_default_model === 'string'
          ? map.one_time_job_default_model.trim()
          : parseStringValue(
              map.one_time_job_default_model,
              'agent.one_time_job_default_model',
            ),
    recurringJobDefaultModel:
      map.recurring_job_default_model === undefined
        ? ''
        : typeof map.recurring_job_default_model === 'string'
          ? map.recurring_job_default_model.trim()
          : parseStringValue(
              map.recurring_job_default_model,
              'agent.recurring_job_default_model',
            ),
    sessions: {
      memoryItemLimit: parsePositiveIntegerValue(
        sessions.memory_item_limit,
        'agent.sessions.memory_item_limit',
        DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT,
      ),
      maxMemoryContextChars: parsePositiveIntegerValue(
        sessions.max_memory_context_chars,
        'agent.sessions.max_memory_context_chars',
        DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS,
      ),
    },
  };
}

function parseRuntimeProcessSettings(raw: unknown): RuntimeProcessSettings {
  const defaults: RuntimeProcessSettings = {
    queue: {
      maxMessageRuns: 3,
      maxJobRuns: 4,
      maxMessageBacklog: 0,
      maxTaskBacklog: 0,
      maxRetries: 5,
      baseRetryMs: 5000,
      drainDeadlineMs: 120000,
    },
    liveTurns: {
      enabled: true,
    },
    sandbox: getDefaultRuntimeSandboxSettings(),
    artifactStore: {
      driver: 'local',
    },
    deploymentMode: 'workstation',
  };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('runtime must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'queue' &&
      key !== 'live_turns' &&
      key !== 'sandbox' &&
      key !== 'artifact_store' &&
      key !== 'deployment_mode'
    ) {
      throw new Error(
        `runtime.${key} is not supported. Configure runtime.queue.*, runtime.live_turns.*, runtime.sandbox.*, runtime.artifact_store.*, or runtime.deployment_mode.`,
      );
    }
  }
  const queueRaw = map.queue;
  if (
    queueRaw !== undefined &&
    (typeof queueRaw !== 'object' ||
      queueRaw === null ||
      Array.isArray(queueRaw))
  ) {
    throw new Error('runtime.queue must be a mapping');
  }
  const queue = (queueRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(queue)) {
    if (
      key !== 'max_message_runs' &&
      key !== 'max_job_runs' &&
      key !== 'max_message_backlog' &&
      key !== 'max_task_backlog' &&
      key !== 'max_retries' &&
      key !== 'base_retry_ms' &&
      key !== 'drain_deadline_ms'
    ) {
      throw new Error(
        `runtime.queue.${key} is not supported. Configure max_message_runs, max_job_runs, max_message_backlog, max_task_backlog, max_retries, base_retry_ms, or drain_deadline_ms.`,
      );
    }
  }
  const liveTurnsRaw = map.live_turns;
  if (
    liveTurnsRaw !== undefined &&
    (typeof liveTurnsRaw !== 'object' ||
      liveTurnsRaw === null ||
      Array.isArray(liveTurnsRaw))
  ) {
    throw new Error('runtime.live_turns must be a mapping');
  }
  const liveTurns = (liveTurnsRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(liveTurns)) {
    if (key !== 'enabled') {
      throw new Error(
        `runtime.live_turns.${key} is not supported. Configure enabled.`,
      );
    }
  }
  const sandboxRaw = map.sandbox;
  if (
    sandboxRaw !== undefined &&
    (typeof sandboxRaw !== 'object' ||
      sandboxRaw === null ||
      Array.isArray(sandboxRaw))
  ) {
    throw new Error('runtime.sandbox must be a mapping');
  }
  const sandbox = (sandboxRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(sandbox)) {
    if (key !== 'provider' && key !== 'resource_limits') {
      throw new Error(
        `runtime.sandbox.${key} is not supported. Configure provider or resource_limits.`,
      );
    }
  }
  const resourceLimitsRaw = sandbox.resource_limits;
  if (
    resourceLimitsRaw !== undefined &&
    (typeof resourceLimitsRaw !== 'object' ||
      resourceLimitsRaw === null ||
      Array.isArray(resourceLimitsRaw))
  ) {
    throw new Error('runtime.sandbox.resource_limits must be a mapping');
  }
  const resourceLimits = (resourceLimitsRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(resourceLimits)) {
    if (
      key !== 'cpu_seconds' &&
      key !== 'memory_mb' &&
      key !== 'max_processes'
    ) {
      throw new Error(
        `runtime.sandbox.resource_limits.${key} is not supported. Configure cpu_seconds, memory_mb, or max_processes.`,
      );
    }
  }
  const provider =
    sandbox.provider === undefined
      ? defaults.sandbox.provider
      : parseStringValue(sandbox.provider, 'runtime.sandbox.provider');
  if (provider !== 'direct' && provider !== 'sandbox_runtime') {
    throw new Error(
      'runtime.sandbox.provider must be direct or sandbox_runtime',
    );
  }
  const artifactStore = parseRuntimeArtifactStoreSettings(map.artifact_store);
  const deploymentMode =
    map.deployment_mode === undefined
      ? defaults.deploymentMode
      : parseStringValue(map.deployment_mode, 'runtime.deployment_mode');
  if (deploymentMode !== 'workstation' && deploymentMode !== 'fleet') {
    throw new Error('runtime.deployment_mode must be workstation or fleet');
  }
  return {
    queue: {
      maxMessageRuns: parsePositiveIntegerValue(
        queue.max_message_runs,
        'runtime.queue.max_message_runs',
        defaults.queue.maxMessageRuns,
      ),
      maxJobRuns: parsePositiveIntegerValue(
        queue.max_job_runs,
        'runtime.queue.max_job_runs',
        defaults.queue.maxJobRuns,
      ),
      maxMessageBacklog: parseNonNegativeIntegerValue(
        queue.max_message_backlog,
        'runtime.queue.max_message_backlog',
        defaults.queue.maxMessageBacklog,
      ),
      maxTaskBacklog: parseNonNegativeIntegerValue(
        queue.max_task_backlog,
        'runtime.queue.max_task_backlog',
        defaults.queue.maxTaskBacklog,
      ),
      maxRetries: parseNonNegativeIntegerValue(
        queue.max_retries,
        'runtime.queue.max_retries',
        defaults.queue.maxRetries,
      ),
      baseRetryMs: parseNonNegativeIntegerValue(
        queue.base_retry_ms,
        'runtime.queue.base_retry_ms',
        defaults.queue.baseRetryMs,
      ),
      drainDeadlineMs: parsePositiveIntegerValue(
        queue.drain_deadline_ms,
        'runtime.queue.drain_deadline_ms',
        defaults.queue.drainDeadlineMs,
      ),
    },
    liveTurns: {
      enabled: parseBooleanValue(
        liveTurns.enabled,
        'runtime.live_turns.enabled',
        defaults.liveTurns.enabled,
      ),
    },
    sandbox: {
      provider,
      resourceLimits: {
        cpuSeconds: parseNonNegativeIntegerValue(
          resourceLimits.cpu_seconds,
          'runtime.sandbox.resource_limits.cpu_seconds',
          defaults.sandbox.resourceLimits.cpuSeconds,
        ),
        memoryMb: parseNonNegativeIntegerValue(
          resourceLimits.memory_mb,
          'runtime.sandbox.resource_limits.memory_mb',
          defaults.sandbox.resourceLimits.memoryMb,
        ),
        maxProcesses: parseNonNegativeIntegerValue(
          resourceLimits.max_processes,
          'runtime.sandbox.resource_limits.max_processes',
          defaults.sandbox.resourceLimits.maxProcesses,
        ),
      },
    },
    artifactStore,
    deploymentMode,
  };
}

function parseRuntimeArtifactStoreSettings(
  raw: unknown,
): RuntimeArtifactStoreSettings {
  if (raw === undefined) return { driver: 'local' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('runtime.artifact_store must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'driver' &&
      key !== 'bucket' &&
      key !== 'region' &&
      key !== 'endpoint' &&
      key !== 'force_path_style'
    ) {
      throw new Error(
        `runtime.artifact_store.${key} is not supported. Configure driver, bucket, region, endpoint, or force_path_style.`,
      );
    }
  }
  const driver =
    map.driver === undefined
      ? 'local'
      : parseStringValue(map.driver, 'runtime.artifact_store.driver');
  if (driver !== 'local' && driver !== 's3') {
    throw new Error('runtime.artifact_store.driver must be local or s3');
  }
  if (driver === 'local') {
    for (const key of ['bucket', 'region', 'endpoint', 'force_path_style']) {
      if (map[key] !== undefined) {
        throw new Error(
          `runtime.artifact_store.${key} is only supported when driver is s3`,
        );
      }
    }
    return { driver: 'local' };
  }
  const bucket = parseStringValue(map.bucket, 'runtime.artifact_store.bucket');
  const region =
    map.region === undefined
      ? undefined
      : parseStringValue(map.region, 'runtime.artifact_store.region');
  const endpoint =
    map.endpoint === undefined
      ? undefined
      : parseStringValue(map.endpoint, 'runtime.artifact_store.endpoint');
  const forcePathStyle =
    map.force_path_style === undefined
      ? undefined
      : parseBooleanValue(
          map.force_path_style,
          'runtime.artifact_store.force_path_style',
        );
  return {
    driver: 's3',
    bucket,
    ...(region !== undefined ? { region } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
  };
}

function parseStorageSettings(raw: unknown): RuntimeStorageSettings {
  if (raw === undefined) {
    return {
      postgres: {
        urlEnv: DEFAULT_STORAGE_POSTGRES_URL_ENV,
        schema: DEFAULT_STORAGE_POSTGRES_SCHEMA,
      },
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('storage must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'postgres') {
      throw new Error(
        `storage.${key} is not supported. Configure storage.postgres.*.`,
      );
    }
  }

  const postgresRaw = map.postgres;
  if (
    postgresRaw !== undefined &&
    (typeof postgresRaw !== 'object' ||
      postgresRaw === null ||
      Array.isArray(postgresRaw))
  ) {
    throw new Error('storage.postgres must be a mapping');
  }
  const postgres = (postgresRaw || {}) as Record<string, unknown>;

  return {
    postgres: {
      urlEnv: parseStringValue(
        postgres.url_env,
        'storage.postgres.url_env',
        DEFAULT_STORAGE_POSTGRES_URL_ENV,
      ),
      schema: parsePostgresSchema(postgres.schema, 'storage.postgres.schema'),
    },
  };
}

function jidForConversation(
  conversation: RuntimeConfiguredConversation,
  providerAccounts: Record<string, RuntimeProviderAccountSettings>,
): string {
  return jidForConfiguredConversation(conversation, providerAccounts);
}

export function parseRuntimeSettings(raw: string): RuntimeSettings {
  const parsed = parseSimpleYamlObject(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }
  return parseRuntimeSettingsObject(parsed as Record<string, unknown>);
}

/**
 * Decode an already-parsed settings document object into typed runtime
 * settings. This is the structural-validation core shared by the YAML file edge
 * (`parseRuntimeSettings`, via `parseSimpleYamlObject`) and the typed JSON
 * settings document carried by the control API / stored in `settings_revisions`
 * (`settingsFromRevisionDocument`). Both surfaces therefore produce identical
 * document-path-level error messages (one validation path, no authority fork).
 */
export function parseRuntimeSettingsObject(
  document: Record<string, unknown>,
): RuntimeSettings {
  const root = normalizeCompactRuntimeSettingsRoot(document);
  for (const key of Object.keys(root)) {
    if (key === 'features') {
      throw new Error(
        'features block is not supported. Configure memory settings under memory.*',
      );
    }
    if (
      key !== 'defaults' &&
      key !== 'desired_state' &&
      key !== 'providers' &&
      key !== 'provider_accounts' &&
      key !== 'conversations' &&
      key !== 'agents' &&
      key !== 'storage' &&
      key !== 'agent' &&
      key !== 'model_access' &&
      key !== 'memory' &&
      key !== 'runtime' &&
      key !== 'browser' &&
      key !== 'permissions' &&
      key !== 'limits' &&
      key !== 'observability' &&
      key !== 'model_families' &&
      key !== 'model_aliases'
    ) {
      throw new Error(
        `${key} is not supported. Supported root keys are defaults, desired_state, providers, provider_accounts, conversations, agents, storage, agent, model_access, memory, runtime, browser, permissions, limits, observability, model_families, and model_aliases.`,
      );
    }
  }

  const modelAliases = parseModelAliases(root.model_aliases);
  const customModelEntries = modelAliasesToCatalogEntries(modelAliases);

  return withCustomModelCatalogEntries(customModelEntries, () => {
    const desiredState = parseDesiredStateSettings(root.desired_state);
    const providers = parseProviderSettings(root.providers);
    const agent = parseAgentSettings(root.agent);
    const modelFamilies = parseModelFamilies(root.model_families);
    const parsedAgents = parseConfiguredAgents(root.agents, {
      model: agent.defaultModel,
      oneTimeJobDefaultModel: agent.oneTimeJobDefaultModel,
      recurringJobDefaultModel: agent.recurringJobDefaultModel,
      agentHarness: agent.agentHarness,
      modelFamilyOrder: modelFamilies,
    });
    const providerAccounts = parseProviderAccounts(
      root.provider_accounts,
      providers,
      parsedAgents,
    );
    const conversations = parseConversations(
      root.conversations,
      providerAccounts,
    );
    const storage = parseStorageSettings(root.storage);
    const bindings = deriveBindingsFromConversationInstalls(conversations);
    const agents = deriveAgentBindingsFromDesiredState({
      agents: parsedAgents,
      providerAccounts,
      conversations,
      bindings,
      jidForConversation: (conversation) =>
        jidForConversation(conversation, providerAccounts),
    });
    const credentialBroker = parseModelAccessSettings(root.model_access);
    const memory = parseMemorySettings(root.memory);
    const runtime = parseRuntimeProcessSettings(root.runtime);
    const browser = parseBrowserSettings(root.browser);
    const permissions = parsePermissionSettings(root.permissions);
    const limits = parseLimitsSettings(root.limits);
    const observability = parseObservabilitySettings(root.observability);

    return {
      desiredState,
      providers,
      providerAccounts,
      conversations,
      conversationInstalls: flattenConversationInstalls(conversations),
      bindings,
      agents,
      storage,
      agent,
      credentialBroker,
      memory,
      runtime,
      browser,
      permissions,
      limits,
      observability,
      modelFamilies,
      modelAliases,
    };
  });
}

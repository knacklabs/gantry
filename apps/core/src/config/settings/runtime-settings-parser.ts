import {
  getProvider,
  listChannelProviders,
  normalizeProviderId,
} from '../../channels/provider-registry.js';
import { resolveModelSelectionForWorkload } from '../../shared/model-catalog.js';
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
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeProcessSettings,
  RuntimeProviderConnectionSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';
import type { ChatAllowlistEntry } from './sender-allowlist.js';
import { parseMemorySettings } from './runtime-settings-memory-parser.js';
import { parseBrowserSettings } from './runtime-settings-browser-parser.js';
import { parsePermissionSettings } from './runtime-settings-permissions-parser.js';

function parseStringArrayValue(raw: unknown, pathPrefix: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a string array`);
  }
  return [
    ...new Set(
      raw.map((item, index) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error(`${pathPrefix}[${index}] must be a non-empty string`);
        }
        return item.trim();
      }),
    ),
  ];
}

function parseOptionalStringValue(
  raw: unknown,
  pathPrefix: string,
): string | undefined {
  if (raw === undefined) return undefined;
  return parseStringValue(raw, pathPrefix);
}

function parseProviderSettings(
  raw: unknown,
): Record<string, RuntimeProviderSettings> {
  const providers = Object.fromEntries(
    listChannelProviders().map((provider) => [
      provider.id,
      { enabled: false, defaultConnection: undefined },
    ]),
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
      if (key !== 'enabled' && key !== 'default_connection') {
        throw new Error(
          `providers.${providerId}.${key} is not supported. Configure enabled or default_connection.`,
        );
      }
    }
    providers[providerId] = {
      enabled: parseBooleanValue(
        map.enabled,
        `providers.${providerId}.enabled`,
      ),
      defaultConnection: parseOptionalStringValue(
        map.default_connection,
        `providers.${providerId}.default_connection`,
      ),
    };
  }
  return providers;
}

function parseProviderConnections(
  raw: unknown,
  providers: Record<string, RuntimeProviderSettings>,
): Record<string, RuntimeProviderConnectionSettings> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('provider_connections must be a mapping');
  }
  const connections: Record<string, RuntimeProviderConnectionSettings> = {};
  for (const [connectionId, connectionRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const pathPrefix = `provider_connections.${connectionId}`;
    if (
      connectionId.trim().length === 0 ||
      containsControlCharacter(connectionId)
    ) {
      throw new Error(`${pathPrefix} must use a stable connection id`);
    }
    if (
      typeof connectionRaw !== 'object' ||
      connectionRaw === null ||
      Array.isArray(connectionRaw)
    ) {
      throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = connectionRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'provider' &&
        key !== 'label' &&
        key !== 'runtime_secret_refs'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure provider, label, or runtime_secret_refs.`,
        );
      }
    }
    const provider = parseStringValue(map.provider, `${pathPrefix}.provider`);
    if (!providers[provider]) {
      throw new Error(
        `${pathPrefix}.provider references unknown provider ${provider}`,
      );
    }
    const refsRaw = map.runtime_secret_refs ?? {};
    if (
      typeof refsRaw !== 'object' ||
      refsRaw === null ||
      Array.isArray(refsRaw)
    ) {
      throw new Error(`${pathPrefix}.runtime_secret_refs must be a mapping`);
    }
    const runtimeSecretRefs: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      refsRaw as Record<string, unknown>,
    )) {
      if (!/^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/.test(key)) {
        throw new Error(
          `${pathPrefix}.runtime_secret_refs.${key} is not a valid key`,
        );
      }
      runtimeSecretRefs[key] = parseStringValue(
        value,
        `${pathPrefix}.runtime_secret_refs.${key}`,
      );
    }
    connections[connectionId] = {
      provider,
      label: parseStringValue(map.label, `${pathPrefix}.label`, connectionId),
      runtimeSecretRefs,
    };
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider.defaultConnection) continue;
    const connection = connections[provider.defaultConnection];
    if (!connection) {
      throw new Error(
        `providers.${providerId}.default_connection references unknown provider connection ${provider.defaultConnection}`,
      );
    }
    if (connection.provider !== providerId) {
      throw new Error(
        `providers.${providerId}.default_connection must reference a ${providerId} connection`,
      );
    }
  }

  return connections;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
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
  providerConnections: Record<string, RuntimeProviderConnectionSettings>,
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
        key !== 'provider_connection' &&
        key !== 'external_id' &&
        key !== 'kind' &&
        key !== 'display_name' &&
        key !== 'sender_policy' &&
        key !== 'control_approvers'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure provider_connection, external_id, kind, display_name, sender_policy, or control_approvers.`,
        );
      }
    }
    const providerConnection = parseStringValue(
      map.provider_connection,
      `${pathPrefix}.provider_connection`,
    );
    const connection = providerConnections[providerConnection];
    if (!connection) {
      throw new Error(
        `${pathPrefix}.provider_connection references unknown provider connection ${providerConnection}`,
      );
    }
    const externalId = parseStringValue(
      map.external_id,
      `${pathPrefix}.external_id`,
    );
    assertExternalIdProviderPrefixMatchesConnection({
      externalId,
      providerId: connection.provider,
      pathPrefix: `${pathPrefix}.external_id`,
    });
    const externalKey = `${connection.provider}:${externalId}`;
    if (seenExternal.has(externalKey)) {
      throw new Error(`${pathPrefix}.external_id duplicates ${externalKey}`);
    }
    seenExternal.add(externalKey);
    conversations[conversationId] = {
      providerConnection,
      externalId,
      kind: parseConversationKind(map.kind, `${pathPrefix}.kind`),
      displayName: parseStringValue(
        map.display_name,
        `${pathPrefix}.display_name`,
        conversationId,
      ),
      senderPolicy: parseSenderPolicy(
        map.sender_policy,
        `${pathPrefix}.sender_policy`,
      ),
      controlApprovers: parseStringArrayValue(
        map.control_approvers ?? [],
        `${pathPrefix}.control_approvers`,
      ),
    };
  }
  return conversations;
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

function parseConfiguredBindings(
  raw: unknown,
  agents: Record<string, { name: string }>,
  conversations: Record<string, RuntimeConfiguredConversation>,
): Record<string, RuntimeConfiguredBinding> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('bindings must be a mapping');
  }
  const bindings: Record<string, RuntimeConfiguredBinding> = {};
  for (const [bindingId, bindingRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const pathPrefix = `bindings.${bindingId}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,95}$/.test(bindingId)) {
      throw new Error(`${pathPrefix} must use a stable binding id`);
    }
    if (
      typeof bindingRaw !== 'object' ||
      bindingRaw === null ||
      Array.isArray(bindingRaw)
    ) {
      throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = bindingRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'agent' &&
        key !== 'conversation' &&
        key !== 'trigger' &&
        key !== 'added_at' &&
        key !== 'requires_trigger' &&
        key !== 'memory_scope' &&
        key !== 'model'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure agent, conversation, trigger, added_at, requires_trigger, memory_scope, or model.`,
        );
      }
    }
    const agent = parseStringValue(map.agent, `${pathPrefix}.agent`);
    if (!agents[agent])
      throw new Error(`${pathPrefix}.agent references unknown agent ${agent}`);
    const conversation = parseStringValue(
      map.conversation,
      `${pathPrefix}.conversation`,
    );
    if (!conversations[conversation]) {
      throw new Error(
        `${pathPrefix}.conversation references unknown conversation ${conversation}`,
      );
    }
    const memoryScope = parseStringValue(
      map.memory_scope,
      `${pathPrefix}.memory_scope`,
      'conversation',
    );
    if (
      memoryScope !== 'conversation' &&
      memoryScope !== 'user' &&
      memoryScope !== 'agent'
    ) {
      throw new Error(
        `${pathPrefix}.memory_scope must be conversation, user, or agent`,
      );
    }
    const model =
      map.model === undefined
        ? undefined
        : typeof map.model === 'string' && map.model.trim() === ''
          ? undefined
          : parseStringValue(map.model, `${pathPrefix}.model`);
    if (model) {
      const resolved = resolveModelSelectionForWorkload(model, 'chat');
      if (!resolved.ok) {
        throw new Error(`${pathPrefix}.model is invalid: ${resolved.message}`);
      }
    }
    bindings[bindingId] = {
      agent,
      conversation,
      trigger: parseStringValue(
        map.trigger,
        `${pathPrefix}.trigger`,
        '@Default Agent',
      ),
      addedAt: parseStringValue(
        map.added_at,
        `${pathPrefix}.added_at`,
        new Date(0).toISOString(),
      ),
      requiresTrigger: parseBooleanValue(
        map.requires_trigger,
        `${pathPrefix}.requires_trigger`,
        true,
      ),
      memoryScope,
      model,
    };
  }
  return bindings;
}

function parseStringValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: string,
): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty string`);
  }
  return raw.trim();
}

function parseBooleanValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: boolean,
): boolean {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(`${pathPrefix} must be true/false`);
  }
  return raw;
}

function parsePositiveIntegerValue(
  raw: unknown,
  pathPrefix: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

function parseNonNegativeIntegerValue(
  raw: unknown,
  pathPrefix: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`${pathPrefix} must be a non-negative integer`);
  }
  return raw;
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
  if (value === '127.0.0.1' || value === 'localhost' || value === '::1') {
    return value;
  }
  throw new Error(
    'model_access.gateway.bind_host must be a loopback host: 127.0.0.1, ::1, or localhost',
  );
}

function parseAgentSettings(raw: unknown): RuntimeAgentSettings {
  if (raw === undefined) {
    return {
      name: DEFAULT_AGENT_NAME,
      defaultModel: '',
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
      key !== 'one_time_job_default_model' &&
      key !== 'recurring_job_default_model' &&
      key !== 'sessions'
    ) {
      throw new Error(
        `agent.${key} is not supported. Configure agent.name, agent.default_model, agent.one_time_job_default_model, agent.recurring_job_default_model, or agent.sessions.*.`,
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
  providerConnections: Record<string, RuntimeProviderConnectionSettings>,
): string {
  const connection = providerConnections[conversation.providerConnection];
  const provider = connection ? getProvider(connection.provider) : undefined;
  if (!provider) return conversation.externalId;
  return conversation.externalId.startsWith(provider.jidPrefix)
    ? conversation.externalId
    : `${provider.jidPrefix}${conversation.externalId}`;
}

function deriveAgentBindingsFromDesiredState(input: {
  agents: ReturnType<typeof parseConfiguredAgents>;
  providerConnections: Record<string, RuntimeProviderConnectionSettings>;
  conversations: Record<string, RuntimeConfiguredConversation>;
  bindings: Record<string, RuntimeConfiguredBinding>;
}): ReturnType<typeof parseConfiguredAgents> {
  const agents = Object.fromEntries(
    Object.entries(input.agents).map(([agentId, agent]) => [
      agentId,
      { ...agent, bindings: { ...agent.bindings } },
    ]),
  );

  for (const [bindingId, binding] of Object.entries(input.bindings)) {
    const agent = agents[binding.agent];
    const conversation = input.conversations[binding.conversation];
    if (!agent || !conversation) continue;
    const connection =
      input.providerConnections[conversation.providerConnection];
    agent.bindings[bindingId] = {
      jid: jidForConversation(conversation, input.providerConnections),
      provider: connection?.provider,
      name: conversation.displayName,
      trigger: binding.trigger,
      addedAt: binding.addedAt,
      requiresTrigger: binding.requiresTrigger,
      model: binding.model ?? agent.model,
    };
  }

  return agents;
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
      key !== 'provider_connections' &&
      key !== 'conversations' &&
      key !== 'bindings' &&
      key !== 'agents' &&
      key !== 'storage' &&
      key !== 'agent' &&
      key !== 'model_access' &&
      key !== 'memory' &&
      key !== 'runtime' &&
      key !== 'browser' &&
      key !== 'permissions'
    ) {
      throw new Error(
        `${key} is not supported. Supported root keys are defaults, desired_state, providers, provider_connections, conversations, bindings, agents, storage, agent, model_access, memory, runtime, browser, and permissions.`,
      );
    }
  }

  const desiredState = parseDesiredStateSettings(root.desired_state);
  const providers = parseProviderSettings(root.providers);
  const providerConnections = parseProviderConnections(
    root.provider_connections,
    providers,
  );
  const conversations = parseConversations(
    root.conversations,
    providerConnections,
  );
  const storage = parseStorageSettings(root.storage);
  const parsedAgents = parseConfiguredAgents(root.agents);
  const bindings = parseConfiguredBindings(
    root.bindings,
    parsedAgents,
    conversations,
  );
  const agents = deriveAgentBindingsFromDesiredState({
    agents: parsedAgents,
    providerConnections,
    conversations,
    bindings,
  });
  const agent = parseAgentSettings(root.agent);
  const credentialBroker = parseModelAccessSettings(root.model_access);
  const memory = parseMemorySettings(root.memory);
  const runtime = parseRuntimeProcessSettings(root.runtime);
  const browser = parseBrowserSettings(root.browser);
  const permissions = parsePermissionSettings(root.permissions);

  return {
    desiredState,
    providers,
    providerConnections,
    conversations,
    bindings,
    agents,
    storage,
    agent,
    credentialBroker,
    memory,
    runtime,
    browser,
    permissions,
  };
}

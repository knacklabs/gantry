import { normalizeRuntimeSecretRefString } from '../../domain/ports/runtime-secret-provider.js';

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function parseOptionalRecord(
  raw: unknown,
  pathPrefix: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${pathPrefix} must be a mapping`);
  return raw;
}

function assertSupportedKeys(
  map: Record<string, unknown>,
  pathPrefix: string,
  supported: Set<string>,
  extraAllowed?: (key: string) => boolean,
): void {
  for (const key of Object.keys(map)) {
    if (!supported.has(key) && !extraAllowed?.(key)) {
      throw new Error(`${pathPrefix}.${key} is not supported`);
    }
  }
}

function defaultConnectionIdForProvider(providerId: string): string {
  return `${providerId}_default`;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

const STORED_REVISION_KEY_ALIASES = new Map<string, string>([
  ['addedAt', 'added_at'],
  ['agentHarness', 'agent_harness'],
  ['accessPreset', 'access_preset'],
  ['artifactStore', 'artifact_store'],
  ['baseRetryMs', 'base_retry_ms'],
  ['batchSize', 'batch_size'],
  ['bindHost', 'bind_host'],
  ['controlApprovers', 'control_approvers'],
  ['contextWindowTokens', 'context_window_tokens'],
  ['cpuSeconds', 'cpu_seconds'],
  ['dailyLimit', 'daily_limit'],
  ['defaultConnection', 'default_connection'],
  ['defaultModel', 'default_model'],
  ['denylistPaths', 'denylist_paths'],
  ['desiredState', 'desired_state'],
  ['deploymentMode', 'deployment_mode'],
  ['displayName', 'display_name'],
  ['drainDeadlineMs', 'drain_deadline_ms'],
  ['externalId', 'external_id'],
  ['extractorMaxFacts', 'extractor_max_facts'],
  ['extractorMinConfidence', 'extractor_min_confidence'],
  ['forcePathStyle', 'force_path_style'],
  ['inputUsdPerMillionTokens', 'input_usd_per_million_tokens'],
  ['liveTurns', 'live_turns'],
  ['maxActionsPerWindow', 'max_actions_per_window'],
  ['maxConcurrentPerSite', 'max_concurrent_per_site'],
  ['maxItemsPerRun', 'max_items_per_run'],
  ['maxJobRuns', 'max_job_runs'],
  ['maxMemoryContextChars', 'max_memory_context_chars'],
  ['maxMessageBacklog', 'max_message_backlog'],
  ['maxMessageRuns', 'max_message_runs'],
  ['maxOutputTokens', 'max_output_tokens'],
  ['maxPending', 'max_pending'],
  ['maxProcesses', 'max_processes'],
  ['maxRetries', 'max_retries'],
  ['maxTaskBacklog', 'max_task_backlog'],
  ['memoryItemLimit', 'memory_item_limit'],
  ['memoryMb', 'memory_mb'],
  ['memoryScope', 'memory_scope'],
  ['mcpServers', 'mcp_servers'],
  ['modelAccess', 'model_access'],
  ['modelAliases', 'model_aliases'],
  ['modelFamilies', 'model_families'],
  ['oneTimeJobDefaultModel', 'one_time_job_default_model'],
  ['outputUsdPerMillionTokens', 'output_usd_per_million_tokens'],
  ['providerBatchMinItems', 'provider_batch_min_items'],
  ['providerConnection', 'provider_connection'],
  ['providerConnections', 'provider_connections'],
  ['providerModelId', 'provider_model_id'],
  ['recurringJobDefaultModel', 'recurring_job_default_model'],
  ['recommendedAlias', 'recommended_alias'],
  ['relationshipMode', 'relationship_mode'],
  ['requestsPerMinute', 'requests_per_minute'],
  ['requiresTrigger', 'requires_trigger'],
  ['resourceLimits', 'resource_limits'],
  ['runtimeSecretRefs', 'runtime_secret_refs'],
  ['senderPolicy', 'sender_policy'],
  ['supportedWorkloads', 'supported_workloads'],
  ['supportsThinking', 'supports_thinking'],
  ['supportsTools', 'supports_tools'],
  ['urlEnv', 'url_env'],
  ['verifiedAt', 'verified_at'],
  ['windowMs', 'window_ms'],
  ['yoloMode', 'yolo_mode'],
]);

function normalizeStoredRevisionAliases(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStoredRevisionAliases);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, rawItem] of Object.entries(value)) {
    const normalizedKey = STORED_REVISION_KEY_ALIASES.get(key) ?? key;
    if (normalized[normalizedKey] !== undefined && normalizedKey !== key) {
      continue;
    }
    normalized[normalizedKey] = normalizeStoredRevisionAliases(rawItem);
  }
  return normalized;
}

function compactProviderToVerbose(
  providerId: string,
  raw: unknown,
): {
  provider: Record<string, unknown>;
  connection?: [string, Record<string, unknown>];
} {
  if (!isRecord(raw)) return { provider: {} };
  const map = raw;
  assertSupportedKeys(
    map,
    `providers.${providerId}`,
    new Set(['enabled', 'default_connection', 'defaultConnection', 'label']),
    (key) => key.endsWith('_ref'),
  );
  const defaultConnection =
    typeof map.default_connection === 'string' && map.default_connection.trim()
      ? map.default_connection.trim()
      : typeof map.defaultConnection === 'string' &&
          map.defaultConnection.trim()
        ? map.defaultConnection.trim()
        : undefined;
  const provider: Record<string, unknown> = {
    enabled: map.enabled,
    default_connection: defaultConnection,
  };
  const secretRefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key.endsWith('_ref')) continue;
    if (typeof value === 'string' && value.trim()) {
      secretRefs[key.slice(0, -'_ref'.length)] =
        normalizeRuntimeSecretRefString(value);
    }
  }
  if (map.label !== undefined || Object.keys(secretRefs).length > 0) {
    const connectionId =
      defaultConnection ?? defaultConnectionIdForProvider(providerId);
    provider.default_connection = connectionId;
    return {
      provider,
      connection: [
        connectionId,
        {
          provider: providerId,
          label:
            typeof map.label === 'string' && map.label.trim()
              ? map.label.trim()
              : `${providerId} Default`,
          runtime_secret_refs: secretRefs,
        },
      ],
    };
  }
  return { provider };
}

function normalizeCompactDefaults(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (root.defaults !== undefined && !isRecord(root.defaults)) {
    throw new Error('defaults must be a mapping');
  }

  if (!isRecord(root.defaults)) return;
  const defaults = root.defaults;
  for (const key of Object.keys(defaults)) {
    if (
      key !== 'name' &&
      key !== 'model' &&
      key !== 'agent_harness' &&
      key !== 'jobs' &&
      key !== 'sessions'
    ) {
      throw new Error(
        `defaults.${key} is not supported. Configure defaults.name, defaults.model, defaults.agent_harness, defaults.jobs.*, or defaults.sessions.*.`,
      );
    }
  }
  const jobs = parseOptionalRecord(defaults.jobs, 'defaults.jobs') || {};
  for (const key of Object.keys(jobs)) {
    if (
      key !== 'one_time_model' &&
      key !== 'recurring_model' &&
      key !== 'one_time_job_default_model' &&
      key !== 'recurring_job_default_model'
    ) {
      throw new Error(
        `defaults.jobs.${key} is not supported. Configure one_time_model or recurring_model.`,
      );
    }
  }
  const sessions = parseOptionalRecord(defaults.sessions, 'defaults.sessions');
  normalized.agent = {
    name: defaults.name,
    default_model: defaults.model,
    agent_harness: defaults.agent_harness,
    one_time_job_default_model:
      jobs.one_time_model ?? jobs.one_time_job_default_model,
    recurring_job_default_model:
      jobs.recurring_model ?? jobs.recurring_job_default_model,
    sessions,
  };
  delete normalized.defaults;
}

function normalizeCompactProviders(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (!isRecord(root.providers)) return;
  const providers: Record<string, unknown> = {};
  const providerConnections: Record<string, unknown> = {
    ...(isRecord(root.provider_connections)
      ? (root.provider_connections as Record<string, unknown>)
      : {}),
  };
  for (const [providerId, providerRaw] of Object.entries(root.providers)) {
    const compact = compactProviderToVerbose(providerId, providerRaw);
    providers[providerId] = compact.provider;
    if (
      compact.connection &&
      providerConnections[compact.connection[0]] === undefined
    ) {
      providerConnections[compact.connection[0]] = compact.connection[1];
    }
  }
  normalized.providers = providers;
  normalized.provider_connections = providerConnections;
}

function normalizeCompactAgents(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (!isRecord(root.agents)) return;
  const agents: Record<string, unknown> = {};
  for (const [agentId, agentRaw] of Object.entries(root.agents)) {
    if (!isRecord(agentRaw)) {
      agents[agentId] = agentRaw;
      continue;
    }
    const jobs =
      parseOptionalRecord(agentRaw.jobs, `agents.${agentId}.jobs`) || {};
    assertSupportedKeys(
      jobs,
      `agents.${agentId}.jobs`,
      new Set([
        'one_time_model',
        'recurring_model',
        'one_time_job_default_model',
        'recurring_job_default_model',
      ]),
    );
    const typedAccess =
      !isRecord(agentRaw.access) &&
      (isRecord(agentRaw.sources) ||
        Array.isArray(agentRaw.capabilities) ||
        agentRaw.access_preset !== undefined)
        ? {
            sources: agentRaw.sources,
            selections: agentRaw.capabilities,
            preset: agentRaw.access_preset,
          }
        : undefined;
    const {
      jobs: _jobs,
      folder: _folder,
      sources: _sources,
      capabilities: _capabilities,
      access_preset: _accessPreset,
      ...verboseAgent
    } = agentRaw;
    agents[agentId] = {
      ...verboseAgent,
      access: agentRaw.access ?? typedAccess,
      one_time_job_default_model:
        agentRaw.one_time_job_default_model ??
        jobs.one_time_model ??
        jobs.one_time_job_default_model,
      recurring_job_default_model:
        agentRaw.recurring_job_default_model ??
        jobs.recurring_model ??
        jobs.recurring_job_default_model,
    };
  }
  normalized.agents = agents;
}

function normalizeTypedCredentialBroker(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (
    normalized.model_access !== undefined ||
    !isRecord(root.credentialBroker)
  ) {
    delete normalized.credentialBroker;
    return;
  }
  const credentialBroker = root.credentialBroker;
  const gateway = isRecord(credentialBroker.gateway)
    ? credentialBroker.gateway
    : {};
  normalized.model_access = {
    enabled: credentialBroker.mode === 'gantry',
    gateway: {
      bind_host: gateway.bind_host,
    },
  };
  delete normalized.credentialBroker;
}

function normalizeCompactConversations(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (!isRecord(root.conversations)) return;
  const conversations: Record<string, unknown> = {};
  const bindings: Record<string, unknown> = {
    ...(isRecord(root.bindings)
      ? (root.bindings as Record<string, unknown>)
      : {}),
  };
  const providers = isRecord(normalized.providers)
    ? (normalized.providers as Record<string, unknown>)
    : {};
  for (const [conversationId, conversationRaw] of Object.entries(
    root.conversations,
  )) {
    if (!isRecord(conversationRaw)) {
      conversations[conversationId] = conversationRaw;
      continue;
    }
    assertSupportedKeys(
      conversationRaw,
      `conversations.${conversationId}`,
      new Set([
        'provider',
        'provider_connection',
        'providerConnection',
        'id',
        'external_id',
        'externalId',
        'type',
        'kind',
        'display_name',
        'displayName',
        'sender_policy',
        'senderPolicy',
        'approvers',
        'control_approvers',
        'controlApprovers',
        'agent',
        'trigger',
        'added_at',
        'addedAt',
        'requires_trigger',
        'requiresTrigger',
        'memory_scope',
        'memoryScope',
        'model',
      ]),
    );
    const providerId =
      typeof conversationRaw.provider === 'string'
        ? conversationRaw.provider.trim()
        : undefined;
    const provider =
      providerId && isRecord(providers[providerId])
        ? (providers[providerId] as Record<string, unknown>)
        : undefined;
    const providerConnection =
      firstDefined(
        conversationRaw.provider_connection,
        conversationRaw.providerConnection,
      ) ??
      provider?.default_connection ??
      (providerId ? defaultConnectionIdForProvider(providerId) : undefined);
    const externalId = firstDefined(
      conversationRaw.id,
      conversationRaw.external_id,
      conversationRaw.externalId,
    );
    const kind = firstDefined(conversationRaw.type, conversationRaw.kind);
    const displayName = firstDefined(
      conversationRaw.display_name,
      conversationRaw.displayName,
    );
    const senderPolicy = firstDefined(
      conversationRaw.sender_policy,
      conversationRaw.senderPolicy,
    );
    const controlApprovers = firstDefined(
      conversationRaw.approvers,
      conversationRaw.control_approvers,
      conversationRaw.controlApprovers,
    );
    conversations[conversationId] = {
      provider_connection: providerConnection,
      external_id: externalId,
      kind,
      display_name: displayName,
      sender_policy: senderPolicy,
      control_approvers: controlApprovers,
    };
    if (conversationRaw.agent !== undefined) {
      bindings[conversationId] = {
        agent: conversationRaw.agent,
        conversation: conversationId,
        trigger: conversationRaw.trigger,
        added_at:
          firstDefined(conversationRaw.added_at, conversationRaw.addedAt) ??
          new Date(0).toISOString(),
        requires_trigger: firstDefined(
          conversationRaw.requires_trigger,
          conversationRaw.requiresTrigger,
        ),
        memory_scope: firstDefined(
          conversationRaw.memory_scope,
          conversationRaw.memoryScope,
        ),
        model: conversationRaw.model,
      };
    }
  }
  normalized.conversations = conversations;
  normalized.bindings = bindings;
}

export function normalizeCompactRuntimeSettingsRoot(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedRoot = normalizeStoredRevisionAliases(root) as Record<
    string,
    unknown
  >;
  const normalized: Record<string, unknown> = { ...normalizedRoot };
  normalizeTypedCredentialBroker(normalized, normalizedRoot);
  normalizeCompactDefaults(normalized, normalizedRoot);
  normalizeCompactProviders(normalized, normalizedRoot);
  normalizeCompactAgents(normalized, normalizedRoot);
  normalizeCompactConversations(normalized, normalizedRoot);
  return normalized;
}

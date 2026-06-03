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
    new Set(['enabled', 'default_connection', 'label']),
    (key) => key.endsWith('_env'),
  );
  const provider: Record<string, unknown> = {
    enabled: map.enabled,
    default_connection: map.default_connection,
  };
  const secretRefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key.endsWith('_env')) continue;
    if (typeof value === 'string' && value.trim()) {
      secretRefs[key.slice(0, -'_env'.length)] = value.trim();
    }
  }
  if (map.label !== undefined || Object.keys(secretRefs).length > 0) {
    const connectionId =
      typeof map.default_connection === 'string' &&
      map.default_connection.trim()
        ? map.default_connection.trim()
        : defaultConnectionIdForProvider(providerId);
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
      key !== 'jobs' &&
      key !== 'sessions'
    ) {
      throw new Error(
        `defaults.${key} is not supported. Configure defaults.name, defaults.model, defaults.jobs.*, or defaults.sessions.*.`,
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
    const { jobs: _jobs, ...verboseAgent } = agentRaw;
    agents[agentId] = {
      ...verboseAgent,
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
        'id',
        'external_id',
        'type',
        'kind',
        'display_name',
        'sender_policy',
        'approvers',
        'control_approvers',
        'agent',
        'trigger',
        'added_at',
        'requires_trigger',
        'memory_scope',
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
      conversationRaw.provider_connection ??
      provider?.default_connection ??
      (providerId ? defaultConnectionIdForProvider(providerId) : undefined);
    conversations[conversationId] = {
      provider_connection: providerConnection,
      external_id: conversationRaw.id ?? conversationRaw.external_id,
      kind: conversationRaw.type ?? conversationRaw.kind,
      display_name: conversationRaw.display_name,
      sender_policy: conversationRaw.sender_policy,
      control_approvers:
        conversationRaw.approvers ?? conversationRaw.control_approvers,
    };
    if (conversationRaw.agent !== undefined) {
      bindings[conversationId] = {
        agent: conversationRaw.agent,
        conversation: conversationId,
        trigger: conversationRaw.trigger,
        added_at: conversationRaw.added_at ?? new Date(0).toISOString(),
        requires_trigger: conversationRaw.requires_trigger,
        memory_scope: conversationRaw.memory_scope,
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
  const normalized: Record<string, unknown> = { ...root };
  normalizeCompactDefaults(normalized, root);
  normalizeCompactProviders(normalized, root);
  normalizeCompactAgents(normalized, root);
  normalizeCompactConversations(normalized, root);
  return normalized;
}

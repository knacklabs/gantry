import { quoteYamlString } from './yaml.js';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS,
  DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT,
  DEFAULT_BROWSER_USAGE_ENABLED,
  DEFAULT_BROWSER_USAGE_MAX_ACTIONS_PER_WINDOW,
  DEFAULT_BROWSER_USAGE_MAX_CONCURRENT_PER_SITE,
  DEFAULT_BROWSER_USAGE_MODE,
  DEFAULT_BROWSER_USAGE_WINDOW_MS,
  DEFAULT_EMBED_DIMENSIONS,
  DEFAULT_EMBED_MODEL,
  DEFAULT_MEMORY_BACKFILL_CRON,
  DEFAULT_MEMORY_BACKFILL_ENABLED,
  DEFAULT_MEMORY_BACKFILL_MAX_ITEMS_PER_RUN,
  DEFAULT_MEMORY_BACKFILL_MODE,
  DEFAULT_MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS,
  DEFAULT_MEMORY_DREAMING_CRON,
  DEFAULT_MEMORY_EMBED_BATCH_SIZE,
  DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
  DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
  DEFAULT_MODEL_GATEWAY_BIND_HOST,
  DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
  DEFAULT_STORAGE_POSTGRES_SCHEMA,
  DEFAULT_STORAGE_POSTGRES_URL_ENV,
  getPresetManagedMemoryDefaults,
} from './runtime-settings-defaults.js';
import type {
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeBrowserSettings,
  RuntimeConfiguredAgentSourceRef,
  RuntimeConfiguredAgent,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeDesiredStateSettings,
  RuntimeMemorySettings,
  RuntimePermissionSettings,
  RuntimeProviderConnectionSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

const SYSTEM_DEFAULT_MODEL_ALIAS = 'opus';

function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

function renderDefaultsYaml(
  lines: string[],
  agent: RuntimeAgentSettings,
): void {
  lines.push('defaults:');
  if (agent.name !== DEFAULT_AGENT_NAME) {
    lines.push(`  name: ${quoteYamlString(agent.name)}`);
  }
  lines.push(
    `  model: ${quoteYamlString(agent.defaultModel || SYSTEM_DEFAULT_MODEL_ALIAS)}`,
  );
  if (agent.oneTimeJobDefaultModel || agent.recurringJobDefaultModel) {
    lines.push('  jobs:');
    if (agent.oneTimeJobDefaultModel) {
      lines.push(
        `    one_time_model: ${quoteYamlString(agent.oneTimeJobDefaultModel)}`,
      );
    }
    if (agent.recurringJobDefaultModel) {
      lines.push(
        `    recurring_model: ${quoteYamlString(agent.recurringJobDefaultModel)}`,
      );
    }
  }
  if (
    agent.sessions.memoryItemLimit !==
      DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT ||
    agent.sessions.maxMemoryContextChars !==
      DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS
  ) {
    lines.push('  sessions:');
    if (
      agent.sessions.memoryItemLimit !== DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT
    ) {
      lines.push(`    memory_item_limit: ${agent.sessions.memoryItemLimit}`);
    }
    if (
      agent.sessions.maxMemoryContextChars !==
      DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS
    ) {
      lines.push(
        `    max_memory_context_chars: ${agent.sessions.maxMemoryContextChars}`,
      );
    }
  }
  lines.push('');
}

function renderDesiredStateYaml(
  lines: string[],
  desiredState: RuntimeDesiredStateSettings,
): void {
  lines.push(
    'desired_state:',
    `  authoritative: ${desiredState.authoritative ? 'true' : 'false'}`,
    '',
  );
}

function renderMemorySettingsYaml(
  lines: string[],
  memory: RuntimeMemorySettings,
): void {
  lines.push(
    'memory:',
    `  enabled: ${memory.enabled ? 'true' : 'false'}`,
    '  embeddings:',
    `    enabled: ${memory.embeddings.enabled ? 'true' : 'false'}`,
    `    provider: ${memory.embeddings.provider}`,
    `    model: ${quoteYamlString(memory.embeddings.model)}`,
    `    dimensions: ${memory.embeddings.dimensions}`,
    `    daily_limit: ${memory.embeddings.dailyLimit}`,
    `    batch_size: ${memory.embeddings.batchSize}`,
    '    backfill:',
    `      enabled: ${memory.embeddings.backfill.enabled ? 'true' : 'false'}`,
    `      cron: ${quoteYamlString(memory.embeddings.backfill.cron)}`,
    `      max_items_per_run: ${memory.embeddings.backfill.maxItemsPerRun}`,
    `      mode: ${memory.embeddings.backfill.mode}`,
    `      provider_batch_min_items: ${memory.embeddings.backfill.providerBatchMinItems}`,
    '  dreaming:',
    `    enabled: ${memory.dreaming.enabled ? 'true' : 'false'}`,
    `    cron: ${quoteYamlString(memory.dreaming.cron)}`,
    '    embeddings:',
    `      enabled: ${memory.dreaming.embeddings.enabled ? 'true' : 'false'}`,
    `      provider: ${memory.dreaming.embeddings.provider}`,
    `      model: ${quoteYamlString(memory.dreaming.embeddings.model)}`,
    '  llm:',
    `    extractor_max_facts: ${memory.llm.extractorMaxFacts}`,
    `    extractor_min_confidence: ${memory.llm.extractorMinConfidence}`,
    '    models:',
    `      extractor: ${quoteYamlString(memory.llm.models.extractor)}`,
    `      dreaming: ${quoteYamlString(memory.llm.models.dreaming)}`,
    `      consolidation: ${quoteYamlString(memory.llm.models.consolidation)}`,
    '  maintenance:',
    `    max_pending: ${memory.maintenance.maxPending}`,
    '',
  );
}

function renderStorageSettingsYaml(
  lines: string[],
  storage: RuntimeStorageSettings,
): void {
  lines.push(
    'storage:',
    '  postgres:',
    `    url_env: ${quoteYamlString(storage.postgres.urlEnv)}`,
    `    schema: ${quoteYamlString(storage.postgres.schema)}`,
    '',
  );
}

function renderPermissionSettingsYaml(
  lines: string[],
  permissions: RuntimePermissionSettings,
): void {
  lines.push(
    'permissions:',
    '  yolo_mode:',
    `    enabled: ${permissions.yoloMode.enabled ? 'true' : 'false'}`,
  );
  if (permissions.yoloMode.denylist.length > 0) {
    lines.push(
      `    denylist: ${JSON.stringify(permissions.yoloMode.denylist)}`,
    );
  }
  if (permissions.yoloMode.denylistPaths.length > 0) {
    lines.push(
      `    denylist_paths: ${JSON.stringify(permissions.yoloMode.denylistPaths)}`,
    );
  }
  lines.push(
    '  egress:',
    `    denylist: ${JSON.stringify(permissions.egress.denylist)}`,
  );
  lines.push('');
}

function renderConfiguredAgentsYaml(
  lines: string[],
  agents: Record<string, RuntimeConfiguredAgent>,
): void {
  const entries = Object.entries(agents).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return;
  }
  lines.push('agents:');
  for (const [folder, agent] of entries) {
    lines.push(
      `  ${quoteYamlKey(folder)}:`,
      `    name: ${quoteYamlString(agent.name)}`,
    );
    if (agent.persona && agent.persona !== 'developer') {
      lines.push(`    persona: ${quoteYamlString(agent.persona)}`);
    }
    if (agent.model) {
      lines.push(`    model: ${quoteYamlString(agent.model)}`);
    }
    if (agent.oneTimeJobDefaultModel) {
      lines.push(
        `    one_time_job_default_model: ${quoteYamlString(agent.oneTimeJobDefaultModel)}`,
      );
    }
    if (agent.recurringJobDefaultModel) {
      lines.push(
        `    recurring_job_default_model: ${quoteYamlString(agent.recurringJobDefaultModel)}`,
      );
    }
    renderAgentAccessYaml(lines, agent);
  }
  lines.push('');
}

function renderAgentAccessYaml(
  lines: string[],
  agent: RuntimeConfiguredAgent,
): void {
  const hasSources =
    agent.sources.skills.length > 0 ||
    agent.sources.mcpServers.length > 0 ||
    agent.sources.tools.length > 0;
  const hasSelections = agent.capabilities.length > 0;
  if (!hasSources && !hasSelections) {
    return;
  }
  lines.push('    access:');
  if (hasSources) {
    lines.push('      sources:');
    renderAgentSourceListYaml(lines, 'skills', agent.sources.skills);
    renderAgentSourceListYaml(lines, 'mcp_servers', agent.sources.mcpServers);
    renderAgentSourceListYaml(lines, 'tools', agent.sources.tools);
  }
  if (hasSelections) {
    lines.push('      selections:');
    for (const selection of agent.capabilities) {
      lines.push(`        - id: ${quoteYamlString(selection.id)}`);
      lines.push(`          version: ${quoteYamlString(selection.version)}`);
    }
  }
}

function renderAgentSourceListYaml(
  lines: string[],
  key: string,
  sources: RuntimeConfiguredAgentSourceRef[],
): void {
  if (sources.length === 0) return;
  lines.push(`        ${key}:`);
  for (const source of sources) {
    if (source.name !== undefined) {
      lines.push(`          - name: ${quoteYamlString(source.name)}`);
      lines.push(`            id: ${quoteYamlString(source.id)}`);
    } else {
      lines.push(`          - id: ${quoteYamlString(source.id)}`);
    }
    if (source.version !== undefined) {
      lines.push(`            version: ${quoteYamlString(source.version)}`);
    }
    if (source.kind !== undefined) {
      lines.push(`            kind: ${quoteYamlString(source.kind)}`);
    }
    if (source.tools !== undefined && source.tools.length > 0) {
      lines.push(`            tools:`);
      for (const tool of source.tools) {
        lines.push(`              - ${quoteYamlString(tool)}`);
      }
    }
  }
}

function renderProviderConnectionsYaml(
  lines: string[],
  connections: Record<string, RuntimeProviderConnectionSettings>,
): void {
  const entries = Object.entries(connections).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    return;
  }
  lines.push('provider_connections:');
  for (const [connectionId, connection] of entries) {
    lines.push(
      `  ${quoteYamlKey(connectionId)}:`,
      `    provider: ${quoteYamlString(connection.provider)}`,
      `    label: ${quoteYamlString(connection.label)}`,
    );
    const refs = Object.entries(connection.runtimeSecretRefs).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (refs.length === 0) {
      lines.push('    runtime_secret_refs: {}');
    } else {
      lines.push('    runtime_secret_refs:');
      for (const [key, value] of refs) {
        lines.push(`      ${quoteYamlKey(key)}: ${quoteYamlString(value)}`);
      }
    }
  }
  lines.push('');
}

function renderConversationsYaml(
  lines: string[],
  conversations: Record<string, RuntimeConfiguredConversation>,
  providers: Record<string, RuntimeProviderSettings>,
  providerConnections: Record<string, RuntimeProviderConnectionSettings>,
  bindingsByConversation: Map<string, RuntimeConfiguredBinding[]>,
): void {
  const entries = Object.entries(conversations).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    return;
  }
  lines.push('conversations:');
  for (const [conversationId, conversation] of entries) {
    const connection = providerConnections[conversation.providerConnection];
    const conversationBindings =
      bindingsByConversation.get(conversationId) || [];
    const binding =
      conversationBindings.length === 1 ? conversationBindings[0] : undefined;
    lines.push(`  ${quoteYamlKey(conversationId)}:`);
    if (
      connection &&
      providers[connection.provider]?.defaultConnection ===
        conversation.providerConnection
    ) {
      lines.push(`    provider: ${quoteYamlString(connection.provider)}`);
    } else {
      lines.push(
        `    provider_connection: ${quoteYamlString(conversation.providerConnection)}`,
      );
    }
    lines.push(
      `    id: ${quoteYamlString(conversation.externalId)}`,
      `    type: ${quoteYamlString(conversation.kind === 'group' ? 'channel' : conversation.kind)}`,
      `    display_name: ${quoteYamlString(conversation.displayName)}`,
    );
    lines.push(
      '    sender_policy:',
      `      allow: ${conversation.senderPolicy.allow === '*' ? '"*"' : JSON.stringify(conversation.senderPolicy.allow)}`,
      `      mode: ${conversation.senderPolicy.mode}`,
    );
    if (conversation.controlApprovers.length > 0) {
      lines.push(
        `    control_approvers: ${JSON.stringify(conversation.controlApprovers)}`,
      );
    }
    if (binding) {
      lines.push(
        `    agent: ${quoteYamlString(binding.agent)}`,
        `    trigger: ${quoteYamlString(binding.trigger)}`,
        `    added_at: ${quoteYamlString(binding.addedAt)}`,
      );
      if (binding.requiresTrigger !== true) {
        lines.push(
          `    requires_trigger: ${binding.requiresTrigger ? 'true' : 'false'}`,
        );
      }
      if (binding.memoryScope !== 'conversation') {
        lines.push(`    memory_scope: ${quoteYamlString(binding.memoryScope)}`);
      }
      if (binding.model) {
        lines.push(`    model: ${quoteYamlString(binding.model)}`);
      }
    }
  }
  lines.push('');
}

function renderBindingsYaml(
  lines: string[],
  bindings: Record<string, RuntimeConfiguredBinding>,
): void {
  const entries = Object.entries(bindings).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    lines.push('bindings: {}', '');
    return;
  }
  lines.push('bindings:');
  for (const [bindingId, binding] of entries) {
    lines.push(
      `  ${quoteYamlKey(bindingId)}:`,
      `    agent: ${quoteYamlString(binding.agent)}`,
      `    conversation: ${quoteYamlString(binding.conversation)}`,
      `    trigger: ${quoteYamlString(binding.trigger)}`,
      `    added_at: ${quoteYamlString(binding.addedAt)}`,
      `    requires_trigger: ${binding.requiresTrigger ? 'true' : 'false'}`,
      `    memory_scope: ${quoteYamlString(binding.memoryScope)}`,
    );
    if (binding.model) {
      lines.push(`    model: ${quoteYamlString(binding.model)}`);
    }
  }
  lines.push('');
}

function bindingsByConversation(
  bindings: Record<string, RuntimeConfiguredBinding>,
): Map<string, RuntimeConfiguredBinding[]> {
  const grouped = new Map<string, RuntimeConfiguredBinding[]>();
  for (const binding of Object.values(bindings)) {
    const existing = grouped.get(binding.conversation);
    if (existing) {
      existing.push(binding);
    } else {
      grouped.set(binding.conversation, [binding]);
    }
  }
  return grouped;
}

function renderModelAccessSettingsYaml(
  lines: string[],
  credentialBroker: RuntimeCredentialBrokerSettings,
): void {
  lines.push(
    'model_access:',
    `  enabled: ${credentialBroker.mode === 'gantry' ? 'true' : 'false'}`,
    '  gateway:',
    `    bind_host: ${quoteYamlString(credentialBroker.gateway.bindHost)}`,
    '',
  );
}

function isDefaultStorage(storage: RuntimeStorageSettings): boolean {
  return (
    storage.postgres.urlEnv === DEFAULT_STORAGE_POSTGRES_URL_ENV &&
    storage.postgres.schema === DEFAULT_STORAGE_POSTGRES_SCHEMA
  );
}

function isDefaultCredentialBroker(
  credentialBroker: RuntimeCredentialBrokerSettings,
): boolean {
  return (
    credentialBroker.mode === 'gantry' &&
    credentialBroker.gateway.bindHost === DEFAULT_MODEL_GATEWAY_BIND_HOST
  );
}

function isDefaultMemory(memory: RuntimeMemorySettings): boolean {
  const models = getPresetManagedMemoryDefaults();
  return (
    memory.enabled === true &&
    memory.embeddings.enabled === false &&
    memory.embeddings.provider === 'disabled' &&
    memory.embeddings.model === DEFAULT_EMBED_MODEL &&
    memory.embeddings.dimensions === DEFAULT_EMBED_DIMENSIONS &&
    memory.embeddings.dailyLimit === DEFAULT_OPENAI_DAILY_EMBED_LIMIT &&
    memory.embeddings.batchSize === DEFAULT_MEMORY_EMBED_BATCH_SIZE &&
    memory.embeddings.backfill.enabled === DEFAULT_MEMORY_BACKFILL_ENABLED &&
    memory.embeddings.backfill.cron === DEFAULT_MEMORY_BACKFILL_CRON &&
    memory.embeddings.backfill.maxItemsPerRun ===
      DEFAULT_MEMORY_BACKFILL_MAX_ITEMS_PER_RUN &&
    memory.embeddings.backfill.mode === DEFAULT_MEMORY_BACKFILL_MODE &&
    memory.embeddings.backfill.providerBatchMinItems ===
      DEFAULT_MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS &&
    memory.dreaming.enabled === false &&
    memory.dreaming.cron === DEFAULT_MEMORY_DREAMING_CRON &&
    memory.dreaming.embeddings.enabled === false &&
    memory.dreaming.embeddings.provider === 'disabled' &&
    memory.dreaming.embeddings.model === DEFAULT_EMBED_MODEL &&
    memory.llm.models.extractor === models.extractor &&
    memory.llm.models.dreaming === models.dreaming &&
    memory.llm.models.consolidation === models.consolidation &&
    memory.llm.extractorMaxFacts === DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS &&
    memory.llm.extractorMinConfidence ===
      DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE &&
    memory.maintenance.maxPending === DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING
  );
}

function isDefaultRuntime(runtime: RuntimeSettings['runtime']): boolean {
  return (
    runtime.queue.maxMessageRuns === 3 &&
    runtime.queue.maxJobRuns === 4 &&
    runtime.queue.maxRetries === 5 &&
    runtime.queue.baseRetryMs === 5000
  );
}

function isDefaultBrowserSettings(browser: RuntimeBrowserSettings): boolean {
  return (
    browser.usage.enabled === DEFAULT_BROWSER_USAGE_ENABLED &&
    browser.usage.mode === DEFAULT_BROWSER_USAGE_MODE &&
    browser.usage.windowMs === DEFAULT_BROWSER_USAGE_WINDOW_MS &&
    browser.usage.maxActionsPerWindow ===
      DEFAULT_BROWSER_USAGE_MAX_ACTIONS_PER_WINDOW &&
    browser.usage.maxConcurrentPerSite ===
      DEFAULT_BROWSER_USAGE_MAX_CONCURRENT_PER_SITE &&
    Object.keys(browser.usage.overrides).length === 0
  );
}

function isDefaultPermissionSettings(
  permissions: RuntimePermissionSettings,
): boolean {
  return (
    permissions.yoloMode.enabled === true &&
    permissions.yoloMode.denylist.length === 0 &&
    permissions.yoloMode.denylistPaths.length === 0 &&
    permissions.egress.denylist.length === 0
  );
}

function renderBrowserSettingsYaml(
  lines: string[],
  browser: RuntimeBrowserSettings,
): void {
  lines.push(
    'browser:',
    '  usage:',
    `    enabled: ${browser.usage.enabled ? 'true' : 'false'}`,
    `    mode: ${quoteYamlString(browser.usage.mode)}`,
    `    window_ms: ${browser.usage.windowMs}`,
    `    max_actions_per_window: ${browser.usage.maxActionsPerWindow}`,
    `    max_concurrent_per_site: ${browser.usage.maxConcurrentPerSite}`,
  );
  const overrides = Object.entries(browser.usage.overrides).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (overrides.length > 0) {
    lines.push('    overrides:');
    for (const [site, override] of overrides) {
      lines.push(`      ${quoteYamlKey(site)}:`);
      if (override.mode !== undefined) {
        lines.push(`        mode: ${quoteYamlString(override.mode)}`);
      }
      if (override.windowMs !== undefined) {
        lines.push(`        window_ms: ${override.windowMs}`);
      }
      if (override.maxActionsPerWindow !== undefined) {
        lines.push(
          `        max_actions_per_window: ${override.maxActionsPerWindow}`,
        );
      }
      if (override.maxConcurrentPerSite !== undefined) {
        lines.push(
          `        max_concurrent_per_site: ${override.maxConcurrentPerSite}`,
        );
      }
    }
  } else {
    lines.push('    overrides: {}');
  }
  lines.push('');
}

function renderRuntimeProcessYaml(
  lines: string[],
  runtime: RuntimeSettings['runtime'],
): void {
  lines.push(
    'runtime:',
    '  queue:',
    `    max_message_runs: ${runtime.queue.maxMessageRuns}`,
    `    max_job_runs: ${runtime.queue.maxJobRuns}`,
    `    max_retries: ${runtime.queue.maxRetries}`,
    `    base_retry_ms: ${runtime.queue.baseRetryMs}`,
    '',
  );
}

function renderProviderConnectionsInlineYaml(
  lines: string[],
  settings: RuntimeSettings,
): Set<string> {
  const renderedConnections = new Set<string>();
  const enabledProviders = Object.entries(settings.providers)
    .filter(([, provider]) => provider.enabled)
    .sort(([a], [b]) => a.localeCompare(b));
  if (enabledProviders.length === 0) return renderedConnections;

  lines.push('providers:');
  for (const [providerId, provider] of enabledProviders) {
    lines.push(`  ${quoteYamlKey(providerId)}:`, '    enabled: true');
    const connectionId = provider.defaultConnection;
    const connection = connectionId
      ? settings.providerConnections[connectionId]
      : undefined;
    if (connectionId && connection?.provider === providerId) {
      renderedConnections.add(connectionId);
      if (connection.label) {
        lines.push(`    label: ${quoteYamlString(connection.label)}`);
      }
      for (const [key, value] of Object.entries(
        connection.runtimeSecretRefs,
      ).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(
          `    ${quoteYamlKey(`${key}_env`)}: ${quoteYamlString(value)}`,
        );
      }
    } else if (connectionId) {
      lines.push(`    default_connection: ${quoteYamlString(connectionId)}`);
    }
  }
  lines.push('');
  return renderedConnections;
}

export function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines: string[] = [];
  if (settings.desiredState.authoritative) {
    renderDesiredStateYaml(lines, settings.desiredState);
  }
  renderDefaultsYaml(lines, settings.agent);
  const renderedInlineConnections = renderProviderConnectionsInlineYaml(
    lines,
    settings,
  );
  const extraConnections = Object.fromEntries(
    Object.entries(settings.providerConnections).filter(
      ([connectionId]) => !renderedInlineConnections.has(connectionId),
    ),
  );
  renderProviderConnectionsYaml(lines, extraConnections);
  renderConfiguredAgentsYaml(lines, settings.agents);
  const groupedBindings = bindingsByConversation(settings.bindings);
  renderConversationsYaml(
    lines,
    settings.conversations,
    settings.providers,
    settings.providerConnections,
    groupedBindings,
  );
  const verboseBindings = Object.fromEntries(
    Object.entries(settings.bindings).filter(([, binding]) => {
      return (groupedBindings.get(binding.conversation)?.length || 0) > 1;
    }),
  );
  if (Object.keys(verboseBindings).length > 0) {
    renderBindingsYaml(lines, verboseBindings);
  }
  if (!isDefaultStorage(settings.storage)) {
    renderStorageSettingsYaml(lines, settings.storage);
  }
  if (!isDefaultCredentialBroker(settings.credentialBroker)) {
    renderModelAccessSettingsYaml(lines, settings.credentialBroker);
  }
  if (!isDefaultMemory(settings.memory)) {
    renderMemorySettingsYaml(lines, settings.memory);
  }
  if (!isDefaultRuntime(settings.runtime)) {
    renderRuntimeProcessYaml(lines, settings.runtime);
  }
  if (!isDefaultBrowserSettings(settings.browser)) {
    renderBrowserSettingsYaml(lines, settings.browser);
  }
  if (!isDefaultPermissionSettings(settings.permissions)) {
    renderPermissionSettingsYaml(lines, settings.permissions);
  }

  return lines.join('\n');
}

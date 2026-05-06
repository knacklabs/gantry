import { quoteYamlString } from './yaml.js';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS,
  DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT,
  DEFAULT_EMBED_MODEL,
  DEFAULT_ONECLI_DATABASE_URL_ENV,
  DEFAULT_ONECLI_POSTGRES_SCHEMA,
  DEFAULT_ONECLI_URL,
  DEFAULT_STORAGE_POSTGRES_SCHEMA,
  DEFAULT_STORAGE_POSTGRES_URL_ENV,
  getMemoryModelProfileDefaults,
} from './runtime-settings-defaults.js';
import type {
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeConfiguredAgent,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeDesiredStateSettings,
  RuntimeMemorySettings,
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

function isOpaqueSkillId(value: string): boolean {
  return /^skill:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
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

function renderAgentSettingsYaml(
  lines: string[],
  agent: RuntimeAgentSettings,
): void {
  lines.push(
    'agent:',
    `  name: ${quoteYamlString(agent.name)}`,
    `  default_model: ${quoteYamlString(agent.defaultModel)}`,
    `  one_time_job_default_model: ${quoteYamlString(agent.oneTimeJobDefaultModel)}`,
    `  recurring_job_default_model: ${quoteYamlString(agent.recurringJobDefaultModel)}`,
    '  sessions:',
    `    memory_item_limit: ${agent.sessions.memoryItemLimit}`,
    `    max_memory_context_chars: ${agent.sessions.maxMemoryContextChars}`,
    '',
  );
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
    '  dreaming:',
    `    enabled: ${memory.dreaming.enabled ? 'true' : 'false'}`,
    '  llm:',
    '    models:',
    `      extractor: ${quoteYamlString(memory.llm.models.extractor)}`,
    `      dreaming: ${quoteYamlString(memory.llm.models.dreaming)}`,
    `      consolidation: ${quoteYamlString(memory.llm.models.consolidation)}`,
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
    if (agent.dmAccess.length > 0) {
      lines.push('    dm_access:');
      for (const entry of [...agent.dmAccess].sort((a, b) =>
        a.provider.localeCompare(b.provider),
      )) {
        lines.push(
          `      ${quoteYamlKey(entry.provider)}:`,
          `        allow: ${JSON.stringify(entry.userIds)}`,
        );
        if (entry.adminUserId) {
          lines.push(`        admin: ${quoteYamlString(entry.adminUserId)}`);
        }
      }
    }
    if (agent.capabilities.toolIds.length > 0) {
      lines.push(`    tools: ${JSON.stringify(agent.capabilities.toolIds)}`);
    }
    const visibleSkillIds = agent.capabilities.skillIds.filter(
      (skillId) => !isOpaqueSkillId(skillId),
    );
    if (visibleSkillIds.length > 0) {
      lines.push(`    skills: ${JSON.stringify(visibleSkillIds)}`);
    }
    if (agent.capabilities.mcpServerIds.length > 0) {
      lines.push(
        `    mcp_servers: ${JSON.stringify(agent.capabilities.mcpServerIds)}`,
      );
    }
  }
  lines.push('');
}

function renderProvidersYaml(
  lines: string[],
  providers: Record<string, RuntimeProviderSettings>,
): void {
  const entries = Object.entries(providers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    return;
  }
  lines.push('providers:');
  for (const [providerId, provider] of entries) {
    if (!provider.enabled) continue;
    lines.push(
      `  ${quoteYamlKey(providerId)}:`,
      `    enabled: ${provider.enabled ? 'true' : 'false'}`,
    );
    if (provider.defaultConnection) {
      lines.push(
        `    default_connection: ${quoteYamlString(provider.defaultConnection)}`,
      );
    }
  }
  lines.push('');
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
      if (binding.isMain) {
        lines.push('    main: true');
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
      `    main: ${binding.isMain ? 'true' : 'false'}`,
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

function renderCredentialBrokerSettingsYaml(
  lines: string[],
  credentialBroker: RuntimeCredentialBrokerSettings,
): void {
  lines.push(
    'credential_broker:',
    `  mode: ${quoteYamlString(credentialBroker.mode)}`,
    '  onecli:',
    `    url: ${quoteYamlString(credentialBroker.onecli.url)}`,
    '    postgres:',
    `      url_env: ${quoteYamlString(credentialBroker.onecli.postgres.urlEnv)}`,
    `      schema: ${quoteYamlString(credentialBroker.onecli.postgres.schema)}`,
    '  external:',
    `    base_url: ${quoteYamlString(credentialBroker.external.baseUrl)}`,
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
    credentialBroker.mode === 'onecli' &&
    credentialBroker.onecli.url === DEFAULT_ONECLI_URL &&
    credentialBroker.onecli.postgres.urlEnv ===
      DEFAULT_ONECLI_DATABASE_URL_ENV &&
    credentialBroker.onecli.postgres.schema ===
      DEFAULT_ONECLI_POSTGRES_SCHEMA &&
    credentialBroker.external.baseUrl === ''
  );
}

function isDefaultMemory(memory: RuntimeMemorySettings): boolean {
  const models = getMemoryModelProfileDefaults('balanced');
  return (
    memory.enabled === true &&
    memory.embeddings.enabled === false &&
    memory.embeddings.provider === 'disabled' &&
    memory.embeddings.model === DEFAULT_EMBED_MODEL &&
    memory.dreaming.enabled === false &&
    memory.llm.models.extractor === models.extractor &&
    memory.llm.models.dreaming === models.dreaming &&
    memory.llm.models.consolidation === models.consolidation
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
    renderCredentialBrokerSettingsYaml(lines, settings.credentialBroker);
  }
  if (!isDefaultMemory(settings.memory)) {
    renderMemorySettingsYaml(lines, settings.memory);
  }

  return lines.join('\n');
}

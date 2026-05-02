import { quoteYamlString } from './yaml.js';
import { normalizePermissionRules } from '../../shared/permission-rules.js';
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

function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
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
    lines.push('agents: {}', '');
    return;
  }
  lines.push('agents:');
  for (const [folder, agent] of entries) {
    lines.push(
      `  ${quoteYamlKey(folder)}:`,
      `    name: ${quoteYamlString(agent.name)}`,
    );
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
    if (agent.dmAccess.length === 0) {
      lines.push('    dm_access: {}');
    } else {
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
    const permissionRules = normalizePermissionRules(
      agent.capabilities.permissionRules,
    );
    lines.push(
      '    capabilities:',
      `      tool_ids: ${JSON.stringify(agent.capabilities.toolIds)}`,
      `      skill_ids: ${JSON.stringify(agent.capabilities.skillIds)}`,
      `      mcp_server_ids: ${JSON.stringify(agent.capabilities.mcpServerIds)}`,
      '      permission_rules:',
      `        allow: ${JSON.stringify(permissionRules.allow)}`,
      `        deny: ${JSON.stringify(permissionRules.deny)}`,
    );
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
    lines.push('providers: {}', '');
    return;
  }
  lines.push('providers:');
  for (const [providerId, provider] of entries) {
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
    lines.push('provider_connections: {}', '');
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
): void {
  const entries = Object.entries(conversations).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    lines.push('conversations: {}', '');
    return;
  }
  lines.push('conversations:');
  for (const [conversationId, conversation] of entries) {
    lines.push(
      `  ${quoteYamlKey(conversationId)}:`,
      `    provider_connection: ${quoteYamlString(conversation.providerConnection)}`,
      `    external_id: ${quoteYamlString(conversation.externalId)}`,
      `    kind: ${quoteYamlString(conversation.kind)}`,
      `    display_name: ${quoteYamlString(conversation.displayName)}`,
      '    sender_policy:',
      `      allow: ${conversation.senderPolicy.allow === '*' ? '"*"' : JSON.stringify(conversation.senderPolicy.allow)}`,
      `      mode: ${conversation.senderPolicy.mode}`,
      `    control_approvers: ${JSON.stringify(conversation.controlApprovers)}`,
    );
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

export function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines: string[] = [];
  renderDesiredStateYaml(lines, settings.desiredState);
  renderProvidersYaml(lines, settings.providers);
  renderProviderConnectionsYaml(lines, settings.providerConnections);
  renderConfiguredAgentsYaml(lines, settings.agents);
  renderConversationsYaml(lines, settings.conversations);
  renderBindingsYaml(lines, settings.bindings);
  renderStorageSettingsYaml(lines, settings.storage);
  renderAgentSettingsYaml(lines, settings.agent);
  renderCredentialBrokerSettingsYaml(lines, settings.credentialBroker);
  renderMemorySettingsYaml(lines, settings.memory);

  return lines.join('\n');
}

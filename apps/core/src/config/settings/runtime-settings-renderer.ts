import { quoteYamlString } from './yaml.js';
import { renderArtifactStoreYamlLines } from './runtime-settings-artifact-store-renderer.js';
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
  DEFAULT_MEMORY_DREAMING_ALERTS,
  DEFAULT_MEMORY_DREAMING_CRON,
  DEFAULT_MEMORY_EMBED_BATCH_SIZE,
  DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
  DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
  DEFAULT_MODEL_GATEWAY_BIND_HOST,
  DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
  DEFAULT_STORAGE_POSTGRES_SCHEMA,
  DEFAULT_STORAGE_POSTGRES_URL_ENV,
  getProviderManagedMemoryDefaults,
} from './runtime-settings-defaults.js';
import type {
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeBrowserSettings,
  RuntimeConfiguredAgentSourceRef,
  RuntimeConfiguredAgent,
  RuntimeConfiguredConversation,
  RuntimeDesiredStateSettings,
  RuntimeMemorySettings,
  RuntimePermissionSettings,
  RuntimeProviderAccountSettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';
import {
  quoteYamlKey,
  renderAgentDelegatesYaml,
  renderLimitsSettingsYaml,
  renderModelAliasesYaml,
  renderModelFamiliesYaml,
  renderObservabilitySettingsYaml,
} from './runtime-settings-optional-blocks-renderer.js';
import { resolveConfiguredAgentRuntime } from './runtime-settings-agent-runtime.js';
const SYSTEM_DEFAULT_MODEL_ALIAS = 'opus';

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
  if (agent.agentHarness !== 'auto') {
    lines.push(`  agent_harness: ${quoteYamlString(agent.agentHarness)}`);
  }
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
  lines.push('memory:', `  enabled: ${memory.enabled ? 'true' : 'false'}`);
  lines.push(
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
    `    alerts: ${memory.dreaming.alerts ? 'true' : 'false'}`,
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
  if (permissions.autoMode.model) {
    lines.push(
      '  auto_mode:',
      `    model: ${quoteYamlString(permissions.autoMode.model)}`,
    );
  }
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
    if (agent.relationshipMode && agent.relationshipMode !== 'personal') {
      lines.push(
        `    relationship_mode: ${quoteYamlString(agent.relationshipMode)}`,
      );
    }
    const agentRuntime = resolveConfiguredAgentRuntime(agent);
    if (agentRuntime !== 'worker') {
      lines.push(`    runtime: ${quoteYamlString(agentRuntime)}`);
    }
    if (agent.maxTurns !== undefined) {
      lines.push(`    max_turns: ${agent.maxTurns}`);
    }
    if (agent.maxRunTokens !== undefined) {
      lines.push(`    max_run_tokens: ${agent.maxRunTokens}`);
    }
    if (agent.effort !== undefined) {
      lines.push(`    effort: ${quoteYamlString(agent.effort)}`);
    }
    if (agent.thinking !== undefined) {
      if (agent.thinking.budgetTokens === undefined) {
        lines.push(`    thinking: ${agent.thinking.mode}`);
      } else {
        lines.push(
          '    thinking:',
          '      mode: on',
          `      budget_tokens: ${agent.thinking.budgetTokens}`,
        );
      }
    }
    if (agent.maxOutputTokens !== undefined) {
      lines.push(`    max_output_tokens: ${agent.maxOutputTokens}`);
    }
    if (agent.model) {
      lines.push(`    model: ${quoteYamlString(agent.model)}`);
    }
    if (agent.agentHarness) {
      lines.push(`    agent_harness: ${quoteYamlString(agent.agentHarness)}`);
    }
    if (agent.permissionMode) {
      lines.push(
        `    permission_mode: ${quoteYamlString(agent.permissionMode)}`,
      );
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
    renderAgentDelegatesYaml(lines, agent.delegates);
    if (agent.toolRules?.length) {
      lines.push('    tool_rules:');
      for (const rule of agent.toolRules) {
        lines.push(
          `      - tool: ${quoteYamlString(rule.tool)}`,
          `        action: ${rule.action}`,
        );
        if (rule.action === 'block' && rule.when) {
          lines.push(
            '        when:',
            `          arg: ${quoteYamlString(rule.when.arg)}`,
            `          matches: ${quoteYamlString(rule.when.matches)}`,
          );
        }
        if (rule.action === 'require_prior') {
          lines.push(`        prior: ${quoteYamlString(rule.prior)}`);
        }
        lines.push(`        reason: ${quoteYamlString(rule.reason)}`);
      }
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
  const hasLockedPreset = agent.accessPreset === 'locked';
  if (!hasSources && !hasSelections && !hasLockedPreset) {
    return;
  }
  lines.push('    access:');
  if (hasLockedPreset) {
    lines.push('      preset: locked');
  }
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
    if (source.status !== undefined) {
      lines.push(`            status: ${source.status}`);
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

function renderProviderAccountsYaml(
  lines: string[],
  accounts: Record<string, RuntimeProviderAccountSettings>,
): void {
  const entries = Object.entries(accounts).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    return;
  }
  lines.push('provider_accounts:');
  for (const [accountId, account] of entries) {
    lines.push(
      `  ${quoteYamlKey(accountId)}:`,
      `    agent: ${quoteYamlString(account.agentId)}`,
      `    provider: ${quoteYamlString(account.provider)}`,
      `    label: ${quoteYamlString(account.label)}`,
    );
    if (account.status === 'disabled') {
      lines.push('    status: disabled');
    }
    const refs = Object.entries(account.runtimeSecretRefs).sort(([a], [b]) =>
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
    const identities = Object.entries(account.externalIdentityRef ?? {}).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    if (identities.length > 0) {
      lines.push('    external_identity_ref:');
      for (const [key, value] of identities) {
        lines.push(`      ${quoteYamlKey(key)}: ${quoteYamlString(value)}`);
      }
    }
    const config = Object.entries(account.config ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (config.length > 0) {
      lines.push('    config:');
      for (const [key, value] of config) {
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
    return;
  }
  lines.push('conversations:');
  for (const [conversationId, conversation] of entries) {
    lines.push(`  ${quoteYamlKey(conversationId)}:`);
    lines.push(
      `    provider_account: ${quoteYamlString(conversation.providerAccount ?? conversation.providerConnection)}`,
    );
    lines.push(
      `    id: ${quoteYamlString(conversation.externalId)}`,
      `    type: ${quoteYamlString(conversation.kind === 'group' ? 'channel' : conversation.kind)}`,
      `    display_name: ${quoteYamlString(conversation.displayName)}`,
    );
    if (conversation.brainHarvest) {
      lines.push('    brain_harvest: true');
    }
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
    const installs = Object.entries(conversation.installedAgents ?? {}).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    if (installs.length > 0) {
      lines.push('    installed_agents:');
      for (const [agentId, install] of installs) {
        lines.push(
          `      ${quoteYamlKey(agentId)}:`,
          `        provider_account: ${quoteYamlString(install.providerAccountId)}`,
          `        added_at: ${quoteYamlString(install.addedAt)}`,
        );
        if (agentId !== install.agentId) {
          lines.push(`        agent: ${quoteYamlString(install.agentId)}`);
        }
        if (install.status !== 'active') {
          lines.push(`        status: ${quoteYamlString(install.status)}`);
        }
        if (install.threadId) {
          lines.push(`        thread_id: ${quoteYamlString(install.threadId)}`);
        }
        if (install.memoryScope !== 'conversation') {
          lines.push(
            `        memory_scope: ${quoteYamlString(install.memoryScope)}`,
          );
        }
        if (install.trigger) {
          lines.push(`        trigger: ${quoteYamlString(install.trigger)}`);
        }
        if (install.requiresTrigger !== undefined) {
          lines.push(`        requires_trigger: ${install.requiresTrigger}`);
        }
        if (install.model) {
          lines.push(`        model: ${quoteYamlString(install.model)}`);
        }
        if (install.permissionMode) {
          lines.push(
            `        permission_mode: ${quoteYamlString(install.permissionMode)}`,
          );
        }
      }
    }
  }
  lines.push('');
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
  const models = getProviderManagedMemoryDefaults();
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
    memory.dreaming.alerts === DEFAULT_MEMORY_DREAMING_ALERTS &&
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
    runtime.queue.maxMessageBacklog === 0 &&
    runtime.queue.maxTaskBacklog === 0 &&
    runtime.queue.maxRetries === 5 &&
    runtime.queue.baseRetryMs === 5000 &&
    runtime.queue.drainDeadlineMs === 120000 &&
    runtime.liveTurns.enabled === true &&
    runtime.sandbox.provider === 'direct' &&
    runtime.sandbox.resourceLimits.cpuSeconds === 0 &&
    runtime.sandbox.resourceLimits.memoryMb === 0 &&
    runtime.sandbox.resourceLimits.maxProcesses === 0 &&
    runtime.artifactStore.driver === 'local' &&
    runtime.deploymentMode === 'workstation'
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
    permissions.egress.denylist.length === 0 &&
    permissions.autoMode.model === undefined
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
    `    max_message_backlog: ${runtime.queue.maxMessageBacklog}`,
    `    max_task_backlog: ${runtime.queue.maxTaskBacklog}`,
    `    max_retries: ${runtime.queue.maxRetries}`,
    `    base_retry_ms: ${runtime.queue.baseRetryMs}`,
    `    drain_deadline_ms: ${runtime.queue.drainDeadlineMs}`,
    '  live_turns:',
    `    enabled: ${runtime.liveTurns.enabled ? 'true' : 'false'}`,
    '  sandbox:',
    `    provider: ${quoteYamlString(runtime.sandbox.provider)}`,
    '    resource_limits:',
    `      cpu_seconds: ${runtime.sandbox.resourceLimits.cpuSeconds}`,
    `      memory_mb: ${runtime.sandbox.resourceLimits.memoryMb}`,
    `      max_processes: ${runtime.sandbox.resourceLimits.maxProcesses}`,
  );
  // Default `workstation` renders nothing (the whole runtime block is omitted
  // when everything is default); only the explicit `fleet` mode is emitted.
  if (runtime.deploymentMode !== 'workstation') {
    lines.push(`  deployment_mode: ${quoteYamlString(runtime.deploymentMode)}`);
  }
  lines.push(...renderArtifactStoreYamlLines(runtime.artifactStore), '');
}

function renderProvidersYaml(lines: string[], settings: RuntimeSettings): void {
  const enabledProviders = Object.entries(settings.providers)
    .filter(([, provider]) => provider.enabled)
    .sort(([a], [b]) => a.localeCompare(b));
  if (enabledProviders.length === 0) return;

  lines.push('providers:');
  for (const [providerId] of enabledProviders) {
    lines.push(`  ${quoteYamlKey(providerId)}:`, '    enabled: true');
  }
  lines.push('');
}

export function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines: string[] = [];
  if (settings.desiredState.authoritative) {
    renderDesiredStateYaml(lines, settings.desiredState);
  }
  renderDefaultsYaml(lines, settings.agent);
  renderProvidersYaml(lines, settings);
  renderProviderAccountsYaml(lines, settings.providerAccounts);
  renderConfiguredAgentsYaml(lines, settings.agents);
  renderConversationsYaml(lines, settings.conversations);
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
  renderLimitsSettingsYaml(lines, settings.limits);
  renderObservabilitySettingsYaml(lines, settings.observability);
  renderModelFamiliesYaml(lines, settings.modelFamilies);
  renderModelAliasesYaml(lines, settings.modelAliases);
  return lines.join('\n');
}

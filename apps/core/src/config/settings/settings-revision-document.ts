import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpBindingAuthorityPrecondition } from '../../domain/mcp/mcp-servers.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import { parseRuntimeSettings } from './runtime-settings.js';
import { renderRuntimeSettingsYaml } from './runtime-settings-renderer.js';
import { parseRuntimeSettingsObject } from './runtime-settings-parser.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

/**
 * Serialize desired state into the typed JSON settings document that the
 * control API/SDK transport and `settings_revisions` store as jsonb. YAML is the
 * human file format for the workstation file + CLI `--file` edge only; it never
 * appears on the wire. The document is the parser's native snake_case object
 * form, built directly from RuntimeSettings so JSON strings and numbers stay
 * lossless.
 */
export function settingsToRevisionDocument(
  settings: RuntimeSettings,
): Record<string, unknown> {
  // Canonicalize via a render→parse round-trip: the parser materializes
  // defaults (persona, requires_trigger, kind aliases, default model) that
  // in-memory objects omit, so documents built from memory and documents
  // built from parsed files would otherwise never compare equal — feeding
  // endless settings.yaml:auto-import echo revisions and stale-base errors.
  return buildRevisionDocument(
    parseRuntimeSettings(renderRuntimeSettingsYaml(settings)),
  );
}

function buildRevisionDocument(
  settings: RuntimeSettings,
): Record<string, unknown> {
  return stripUndefinedDeep({
    desired_state: snakeRecord(settings.desiredState),
    providers: mapRecord(settings.providers, snakeRecord),
    provider_accounts: mapRecord(settings.providerAccounts, (account) => ({
      agent: account.agentId,
      provider: account.provider,
      label: account.label,
      status: account.status === 'disabled' ? account.status : undefined,
      runtime_secret_refs: account.runtimeSecretRefs,
      external_identity_ref: account.externalIdentityRef,
      config:
        Object.keys(account.config ?? {}).length > 0
          ? account.config
          : undefined,
    })),
    conversations: mapRecord(settings.conversations, (conversation) => ({
      provider_account:
        conversation.providerAccount ?? conversation.providerConnection,
      external_id: conversation.externalId,
      kind: conversation.kind,
      display_name: conversation.displayName,
      brain_harvest: conversation.brainHarvest ? true : undefined,
      sender_policy: conversation.senderPolicy,
      control_approvers: conversation.controlApprovers,
      installed_agents: Object.fromEntries(
        Object.entries(conversation.installedAgents ?? {}).map(
          ([installId, install]) => [
            installId,
            {
              provider_account: install.providerAccountId,
              agent:
                installId === install.agentId ? undefined : install.agentId,
              thread_id: install.threadId,
              status: install.status,
              added_at: install.addedAt,
              memory_scope: install.memoryScope,
              trigger: install.trigger,
              requires_trigger: install.requiresTrigger,
              model: install.model,
              permission_mode: install.permissionMode,
            },
          ],
        ),
      ),
    })),
    agents: mapRecord(settings.agents, (agent) => ({
      name: agent.name,
      persona: agent.persona,
      delegates: agent.delegates.length > 0 ? agent.delegates : undefined,
      relationship_mode:
        agent.relationshipMode && agent.relationshipMode !== 'personal'
          ? agent.relationshipMode
          : undefined,
      runtime: agent.runtime === 'inline' ? 'inline' : undefined,
      max_turns: agent.maxTurns,
      max_run_tokens: agent.maxRunTokens,
      effort: agent.effort,
      thinking:
        agent.thinking?.budgetTokens === undefined
          ? agent.thinking?.mode
          : {
              mode: agent.thinking.mode,
              budget_tokens: agent.thinking.budgetTokens,
            },
      max_output_tokens: agent.maxOutputTokens,
      model: agent.model,
      agent_harness: agent.agentHarness,
      permission_mode: agent.permissionMode,
      one_time_job_default_model: agent.oneTimeJobDefaultModel,
      recurring_job_default_model: agent.recurringJobDefaultModel,
      tool_rules:
        agent.toolRules && agent.toolRules.length > 0
          ? agent.toolRules
          : undefined,
      access: {
        preset: agent.accessPreset,
        sources: {
          skills: agent.sources.skills.map(snakeRecord),
          mcp_servers: agent.sources.mcpServers.map(snakeRecord),
          tools: agent.sources.tools.map(snakeRecord),
        },
        selections: agent.capabilities.map(snakeRecord),
      },
    })),
    storage: {
      postgres: {
        url_env: settings.storage.postgres.urlEnv,
        schema: settings.storage.postgres.schema,
      },
    },
    agent: {
      name: settings.agent.name,
      default_model: settings.agent.defaultModel,
      agent_harness: settings.agent.agentHarness,
      one_time_job_default_model: settings.agent.oneTimeJobDefaultModel,
      recurring_job_default_model: settings.agent.recurringJobDefaultModel,
      sessions: {
        memory_item_limit: settings.agent.sessions.memoryItemLimit,
        max_memory_context_chars: settings.agent.sessions.maxMemoryContextChars,
      },
    },
    model_access: {
      enabled: settings.credentialBroker.mode === 'gantry',
      gateway: {
        bind_host: settings.credentialBroker.gateway.bindHost,
      },
    },
    memory: snakeRecord(settings.memory),
    runtime: snakeRecord(settings.runtime),
    authentication: snakeRecord(settings.authentication),
    browser: {
      usage: {
        enabled: settings.browser.usage.enabled,
        mode: settings.browser.usage.mode,
        window_ms: settings.browser.usage.windowMs,
        max_actions_per_window: settings.browser.usage.maxActionsPerWindow,
        max_concurrent_per_site: settings.browser.usage.maxConcurrentPerSite,
        overrides: mapRecord(settings.browser.usage.overrides, snakeRecord),
      },
    },
    permissions: snakeRecord(settings.permissions),
    observability: snakeRecord(settings.observability),
    observer: snakeRecord(settings.observer),
    model_aliases: mapRecord(settings.modelAliases, snakeRecord),
    limits: mapRecord(settings.limits.providers, snakeRecord),
    model_families: settings.modelFamilies,
  }) as Record<string, unknown>;
}

/** Re-hydrate a typed settings document back into typed runtime settings. */
export function settingsFromRevisionDocument(
  document: Record<string, unknown>,
): RuntimeSettings {
  assertNoLegacyAgentBindings(document);
  return parseRuntimeSettingsObject(document);
}

function assertNoLegacyAgentBindings(document: Record<string, unknown>): void {
  if (!isRecord(document.agents)) return;
  for (const [agentId, agent] of Object.entries(document.agents)) {
    if (isRecord(agent) && Object.hasOwn(agent, 'bindings')) {
      throw new Error(
        `agents.${agentId}.bindings is no longer supported in settings revisions. Reset the stored settings revision and re-import canonical settings without agents.*.bindings.`,
      );
    }
  }
}

export async function settingsMatchesLatestRevision(input: {
  appId: AppId;
  settings: RuntimeSettings;
  settingsRevisions: SettingsRevisionRepository;
}): Promise<boolean> {
  const latest = await input.settingsRevisions.getLatestSettingsRevision(
    input.appId,
  );
  if (!latest) return false;
  return revisionDocumentMatchesSettings(
    latest.settingsDocument,
    input.settings,
  );
}

export function revisionDocumentMatchesSettings(
  document: Record<string, unknown>,
  settings: RuntimeSettings,
): boolean {
  return (
    stableJson(canonicalizeRevisionDocument(document)) ===
    stableJson(
      canonicalizeRevisionDocument(settingsToRevisionDocument(settings)),
    )
  );
}

export function revisionMcpBindingPreconditionsMatch(
  storedAgentIds: readonly AgentId[] | undefined,
  stored: readonly McpBindingAuthorityPrecondition[] | undefined,
  expectedAgentIds: readonly AgentId[] | undefined,
  expected: readonly McpBindingAuthorityPrecondition[] | undefined,
): boolean {
  if (expectedAgentIds === undefined && expected === undefined) {
    return (storedAgentIds?.length ?? 0) === 0;
  }
  return (
    stableJson([...(storedAgentIds ?? [])].sort()) ===
      stableJson([...(expectedAgentIds ?? [])].sort()) &&
    stableJson(canonicalMcpBindingPreconditions(stored ?? [])) ===
      stableJson(canonicalMcpBindingPreconditions(expected ?? []))
  );
}

function canonicalMcpBindingPreconditions(
  bindings: readonly McpBindingAuthorityPrecondition[],
): McpBindingAuthorityPrecondition[] {
  return bindings
    .map((binding) => ({
      ...binding,
      permissionPolicyIds: [...new Set(binding.permissionPolicyIds)].sort(),
      allowedToolPatterns: [...new Set(binding.allowedToolPatterns)].sort(),
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function agentIdsFromMcpBindingPreconditions(
  bindings: readonly McpBindingAuthorityPrecondition[] | undefined,
): AgentId[] | undefined {
  if (bindings === undefined) return undefined;
  return [...new Set(bindings.map((binding) => binding.agentId))].sort();
}

function canonicalizeRevisionDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return settingsToRevisionDocument(settingsFromRevisionDocument(document));
  } catch {
    return document;
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapRecord<T>(
  record: Record<string, T>,
  mapValue: (value: T) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, mapValue(value)]),
  );
}

function snakeRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeRecord);
  if (typeof value !== 'object' || value === null) return value;
  return stripUndefined(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        snakeRecord(item),
      ]),
    ),
  );
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return stripUndefinedDeep(record) as T;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, stripUndefinedDeep(item)]],
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

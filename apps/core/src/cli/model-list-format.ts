import {
  DEFAULT_SETUP_MODEL_ALIAS,
  listModelCatalogEntries,
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../shared/model-cache-support.js';
import {
  formatContextWindow,
  formatCostPerMillion,
} from '../shared/model-catalog-format.js';
import {
  isModelFamilyAlias,
  listModelFamilies,
  resolveModelFamilyAlias,
  resolveModelSelectionForWorkloadWithFamilies,
  type FamilyOrderOverrides,
} from '../shared/model-families.js';
import {
  availabilityBadgeForProvider,
  describeFamilyAvailability,
  familyAvailabilityBadge,
  providerLabel,
} from '../shared/model-catalog-availability.js';
import { controlApiRequest } from './control-api.js';

// `gantry model list` rendering, split out of cli/model.ts. Credential-aware:
// when a configured-provider set is supplied each row gains an availability
// badge; when absent the list renders without badges (graceful degrade).
//
// Settings are read through a narrow structural shape (no config-layer import)
// so this adapter file stays off the adapters->config exception ledger.
interface ModelListSettings {
  agent: {
    defaultModel: string;
    oneTimeJobDefaultModel: string;
    recurringJobDefaultModel: string;
  };
  memory: {
    llm: {
      models: { extractor: string; dreaming: string; consolidation: string };
    };
  };
  modelFamilies: Record<string, string[]>;
}

// `gantry model status` settings shape: the list shape plus per-agent and
// per-binding model overrides (same structural, no-config-import rule).
export interface ModelStatusSettings extends ModelListSettings {
  agents: Record<
    string,
    {
      model?: string;
      oneTimeJobDefaultModel?: string;
      recurringJobDefaultModel?: string;
    }
  >;
  bindings: Record<string, { model?: string }>;
}

export function chatAlias(settings: ModelListSettings): string {
  return settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
}

export function effectiveJobAlias(
  settings: ModelListSettings,
  kind: 'oneTime' | 'recurring',
): string {
  const explicit =
    kind === 'oneTime'
      ? settings.agent.oneTimeJobDefaultModel
      : settings.agent.recurringJobDefaultModel;
  return explicit || chatAlias(settings);
}

export function providerForAlias(
  alias: string,
  workload: ModelWorkload,
  familyOrder?: FamilyOrderOverrides,
): string | undefined {
  // Family-aware: family aliases resolve to their selected member's provider.
  const resolved = resolveModelSelectionForWorkloadWithFamilies(
    alias,
    workload,
    familyOrder,
  );
  return resolved.ok ? resolved.entry.modelRoute.id : undefined;
}

export function providerFromSettings(settings: ModelListSettings): string {
  return (
    providerForAlias(chatAlias(settings), 'chat', settings.modelFamilies) ??
    'anthropic'
  );
}

// Configured model providers for CLI family resolution. Storage is the
// source of truth and works with the service stopped; the control API is
// the fallback when storage is unreachable from this process. Both are
// lazy/dynamic so this file's static graph stays config-free.
export async function configuredProviderIdsForCli(
  runtimeHome: string,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const { listReadyModelCredentialProviders } =
      await import('./credentials.js');
    return await listReadyModelCredentialProviders(runtimeHome);
  } catch {
    return fetchConfiguredProviders(runtimeHome);
  }
}

export async function memoryResetProviderFromSettings(
  runtimeHome: string,
  settings: ModelListSettings,
): Promise<string> {
  const fallback = providerFromSettings(settings);
  const alias = chatAlias(settings);
  if (!isModelFamilyAlias(alias)) return fallback;
  const configuredProviders = await configuredProviderIdsForCli(runtimeHome);
  if (!configuredProviders) return fallback;
  const concreteAlias = resolveModelFamilyAlias(alias, {
    isProviderConfigured: (providerId) => configuredProviders.has(providerId),
    order: familyOrderFromSettings(settings),
  })?.alias;
  return (concreteAlias && providerForAlias(concreteAlias, 'chat')) ?? fallback;
}

export function memoryProviderFromSettings(
  settings: ModelListSettings,
): string {
  const providers = [
    providerForAlias(settings.memory.llm.models.extractor, 'memory_extractor'),
    providerForAlias(settings.memory.llm.models.dreaming, 'memory_dreaming'),
    providerForAlias(
      settings.memory.llm.models.consolidation,
      'memory_consolidation',
    ),
  ].filter((provider): provider is string => Boolean(provider));
  const unique = [...new Set(providers)];
  if (unique.length === 1) return unique[0]!;
  return unique.length === 0 ? providerFromSettings(settings) : 'mixed';
}

export function resolveSlot(alias: string, workload: ModelWorkload): string {
  const resolved = resolveModelSelectionForWorkload(alias, workload);
  return resolved.ok
    ? `${resolved.alias} (${resolved.entry.displayName}; cache: ${resolveModelCacheSupport(resolved.entry).statusLabel})`
    : `invalid (${resolved.message})`;
}

function formatAgentOverrides(settings: ModelStatusSettings): string[] {
  const lines: string[] = [];
  for (const [agentId, agent] of Object.entries(settings.agents)) {
    const overrides = [
      agent.model ? `chat=${agent.model}` : undefined,
      agent.oneTimeJobDefaultModel
        ? `one-time=${agent.oneTimeJobDefaultModel}`
        : undefined,
      agent.recurringJobDefaultModel
        ? `recurring=${agent.recurringJobDefaultModel}`
        : undefined,
    ].filter(Boolean);
    if (overrides.length)
      lines.push(`agent ${agentId}: ${overrides.join(', ')}`);
  }
  for (const [bindingId, binding] of Object.entries(settings.bindings)) {
    if (binding.model)
      lines.push(`binding ${bindingId}: chat=${binding.model}`);
  }
  return lines;
}

export function formatModelStatus(settings: ModelStatusSettings): string {
  const providerId = providerFromSettings(settings);
  const oneTimeInherited = !settings.agent.oneTimeJobDefaultModel;
  const recurringInherited = !settings.agent.recurringJobDefaultModel;
  const lines = [
    'Model status',
    `provider: ${providerId} (${providerLabel(providerId)})`,
    `chat: ${resolveSlot(chatAlias(settings), 'chat')}`,
    `one-time: ${
      oneTimeInherited
        ? `inherits chat (${resolveSlot(effectiveJobAlias(settings, 'oneTime'), 'one_time_job')})`
        : resolveSlot(effectiveJobAlias(settings, 'oneTime'), 'one_time_job')
    }`,
    `recurring: ${
      recurringInherited
        ? `inherits chat (${resolveSlot(effectiveJobAlias(settings, 'recurring'), 'recurring_job')})`
        : resolveSlot(effectiveJobAlias(settings, 'recurring'), 'recurring_job')
    }`,
    `memory: provider-managed (from ${memoryProviderFromSettings(settings)})`,
    `memory extractor: ${resolveSlot(settings.memory.llm.models.extractor, 'memory_extractor')}`,
    `memory dreaming: ${resolveSlot(settings.memory.llm.models.dreaming, 'memory_dreaming')}`,
    `memory consolidation: ${resolveSlot(settings.memory.llm.models.consolidation, 'memory_consolidation')}`,
  ];
  const overrides = formatAgentOverrides(settings);
  lines.push(
    overrides.length
      ? `overrides:\n${overrides.map((line) => `  ${line}`).join('\n')}`
      : 'overrides: none configured',
  );
  return lines.join('\n');
}

function defaultsFor(settings: ModelListSettings) {
  return {
    chat: chatAlias(settings),
    oneTime: settings.agent.oneTimeJobDefaultModel || undefined,
    recurring: settings.agent.recurringJobDefaultModel || undefined,
    memoryExtractor: settings.memory.llm.models.extractor || undefined,
    memoryDreaming: settings.memory.llm.models.dreaming || undefined,
    memoryConsolidation: settings.memory.llm.models.consolidation || undefined,
  };
}

function aliasStatus(
  alias: string,
  entry: ModelCatalogEntry,
  defaults: ReturnType<typeof defaultsFor>,
): string {
  const statuses: string[] = [
    alias === entry.recommendedAlias ? 'recommended' : 'pinned',
  ];
  if (defaults.chat === alias) statuses.push('chat');
  if (defaults.oneTime === alias) statuses.push('one-time jobs');
  if (defaults.recurring === alias) statuses.push('recurring jobs');
  if (defaults.memoryExtractor === alias) statuses.push('memory extractor');
  if (defaults.memoryDreaming === alias) statuses.push('memory dreaming');
  if (defaults.memoryConsolidation === alias)
    statuses.push('memory consolidation');
  return statuses.join(', ');
}

export function formatModelList(
  settings: ModelListSettings,
  providerId: string | undefined,
  availability: {
    configuredProviders?: Set<string>;
    familyOrder?: FamilyOrderOverrides;
  } = {},
): string {
  const defaults = defaultsFor(settings);
  const { configuredProviders, familyOrder } = availability;
  const hasAvailability = configuredProviders !== undefined;
  const header = hasAvailability
    ? 'Alias | Model | Response family | Route | Context | Cache | Cost (in/out per 1M) | Availability | Status'
    : 'Alias | Model | Response family | Route | Context | Cache | Cost (in/out per 1M) | Status';
  const rows = [
    'Available model aliases',
    header,
    header.replace(/[^|]+/g, '---'),
  ];
  for (const entry of listModelCatalogEntries()) {
    if (providerId && entry.modelRoute.id !== providerId) continue;
    const cacheSupport = resolveModelCacheSupport(entry);
    const badge = availabilityBadgeForProvider(
      entry.modelRoute.id,
      configuredProviders,
    );
    for (const alias of entry.aliases) {
      const cells = [
        alias,
        entry.displayName,
        entry.responseFamily,
        entry.modelRoute.label,
        formatContextWindow(entry.contextWindowTokens),
        cacheSupport.statusLabel,
        formatCostPerMillion(entry),
        ...(hasAvailability ? [badge ?? ''] : []),
        aliasStatus(alias, entry, defaults),
      ];
      rows.push(cells.join(' | '));
    }
  }
  if (!providerId) {
    const familyHeader = hasAvailability
      ? 'Family | Model | Providers (preference order) | Availability'
      : 'Family | Model | Providers (preference order)';
    rows.push(
      '',
      'Model families (provider auto-selected by configured key)',
      'Reorder members or rank by price with `cheapest` via settings.yaml model_families.<family>.',
      familyHeader,
      familyHeader.replace(/[^|]+/g, '---'),
      ...listModelFamilies().map((family) => {
        const description = describeFamilyAvailability(
          family,
          configuredProviders,
          familyOrder,
        );
        const order = description.members
          .map((member) => member.member)
          .join(' > ');
        const cells = [
          family.alias,
          family.displayName,
          order,
          ...(hasAvailability
            ? [familyAvailabilityBadge(description, configuredProviders) ?? '']
            : []),
        ];
        return cells.join(' | ');
      }),
    );
  }
  return rows.join('\n');
}

// Best-effort configured-provider set for `gantry model list`/`why` badges via
// the control API. Returns undefined when the API is unreachable, unauthorized,
// or missing the credentials:read scope so the CLI degrades to NO badges
// (current behavior) instead of failing.
export async function fetchConfiguredProviders(
  runtimeHome: string,
): Promise<Set<string> | undefined> {
  try {
    const response = (await controlApiRequest(runtimeHome, {
      method: 'GET',
      path: '/v1/credentials/models',
    })) as { providers?: Array<{ providerId?: string; configured?: boolean }> };
    const providers = response.providers ?? [];
    return new Set(
      providers
        .filter(
          (provider) => provider.configured === true && provider.providerId,
        )
        .map((provider) => provider.providerId as string),
    );
  } catch {
    return undefined;
  }
}

export function familyOrderFromSettings(
  settings: ModelListSettings,
): FamilyOrderOverrides | undefined {
  return settings.modelFamilies;
}

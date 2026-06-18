import {
  DEFAULT_SETUP_MODEL_ALIAS,
  listModelCatalogEntries,
  type ModelCatalogEntry,
  type ModelPresetId,
} from '../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../shared/model-cache-support.js';
import {
  formatContextWindow,
  formatCostPerMillion,
} from '../shared/model-catalog-format.js';
import {
  listModelFamilies,
  type FamilyOrderOverrides,
} from '../shared/model-families.js';
import {
  availabilityBadgeForProvider,
  describeFamilyAvailability,
  familyAvailabilityBadge,
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

function chatAlias(settings: ModelListSettings): string {
  return settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
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
  preset: ModelPresetId | undefined,
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
    if (preset && entry.modelRoute.id !== preset) continue;
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
  if (!preset) {
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

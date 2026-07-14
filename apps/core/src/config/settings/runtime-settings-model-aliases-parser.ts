import {
  executableModelEntry,
  type ModelCacheMode,
  providerRoute,
  type ModelCatalogEntry,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import {
  getModelProviderDefinition,
  normalizeModelRouteProviderId,
} from '../../shared/model-provider-registry.js';
import type { RuntimeCustomModelAlias } from './runtime-settings-types.js';
import {
  containsControlCharacter,
  parseBooleanValue,
  parsePositiveIntegerValue,
  parseStringArrayValue,
  parseStringValue,
} from './runtime-settings-parse-primitives.js';

const MODEL_WORKLOADS: readonly ModelWorkload[] = [
  'chat',
  'one_time_job',
  'recurring_job',
  'memory_extractor',
  'memory_dreaming',
  'memory_consolidation',
];

export function parseModelAliases(
  raw: unknown,
): Record<string, RuntimeCustomModelAlias> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('model_aliases must be a mapping');
  }
  const aliases: Record<string, RuntimeCustomModelAlias> = {};
  for (const [aliasId, aliasRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    aliases[aliasId] = parseModelAlias(aliasRaw, aliasId);
  }
  return aliases;
}

export function modelAliasesToCatalogEntries(
  aliases: Record<string, RuntimeCustomModelAlias>,
): readonly ModelCatalogEntry[] {
  return Object.entries(aliases).map(([aliasId, alias]) => {
    const cache = cacheSettingsForProvider(alias.provider);
    return executableModelEntry({
      id: `settings:${aliasId}`,
      route: providerRoute(alias.provider, alias.providerModelId),
      displayName: alias.displayName,
      runnerModel: alias.providerModelId,
      aliases: alias.aliases,
      recommendedAlias: alias.recommendedAlias,
      source: alias.source,
      contextWindowTokens: alias.contextWindowTokens,
      maxOutputTokens: alias.maxOutputTokens,
      inputUsdPerMillionTokens: alias.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: alias.outputUsdPerMillionTokens,
      cachedInputUsdPerMillionTokens: alias.cachedInputUsdPerMillionTokens,
      cacheWriteUsdPerMillionTokens: alias.cacheWriteUsdPerMillionTokens,
      cacheMode: cache.cacheMode,
      cacheTokenFields: cache.cacheTokenFields,
      supportsThinking: alias.supportsThinking,
      supportsTools: alias.supportsTools,
      supportedWorkloads: alias.supportedWorkloads,
      experimental: true,
    });
  });
}

function cacheSettingsForProvider(providerId: string): {
  cacheMode: ModelCacheMode;
  cacheTokenFields: readonly string[];
} {
  const prompt = getModelProviderDefinition(providerId)?.cacheSupport.prompt;
  const cacheMode = prompt ? cacheModeForPromptMode(prompt.mode) : undefined;
  if (!prompt || !cacheMode) {
    return { cacheMode: 'none', cacheTokenFields: [] };
  }
  const cacheTokenFields = [
    prompt.usageFields.writeTokens,
    prompt.usageFields.readTokens,
  ].filter((field): field is string => typeof field === 'string');
  return { cacheMode, cacheTokenFields };
}

function cacheModeForPromptMode(mode: string): ModelCacheMode | undefined {
  if (mode === 'none') return undefined;
  const providerPrefix = mode.split('_', 1)[0];
  if (mode.endsWith('_cache_control')) {
    return `${providerPrefix}-prompt` as ModelCacheMode;
  }
  if (mode.endsWith('_automatic_prefix')) {
    const suffix =
      providerPrefix === 'openrouter' ? 'provider-prompt' : 'automatic-prompt';
    return `${providerPrefix}-${suffix}` as ModelCacheMode;
  }
  return undefined;
}

function parseModelAlias(
  raw: unknown,
  aliasId: string,
): RuntimeCustomModelAlias {
  const pathPrefix = `model_aliases.${aliasId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(aliasId)) {
    throw new Error(`${pathPrefix} must use a stable alias id`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'provider' &&
      key !== 'provider_model_id' &&
      key !== 'display_name' &&
      key !== 'aliases' &&
      key !== 'recommended_alias' &&
      key !== 'supported_workloads' &&
      key !== 'context_window_tokens' &&
      key !== 'max_output_tokens' &&
      key !== 'input_usd_per_million_tokens' &&
      key !== 'output_usd_per_million_tokens' &&
      key !== 'cached_input_usd_per_million_tokens' &&
      key !== 'cache_write_usd_per_million_tokens' &&
      key !== 'supports_thinking' &&
      key !== 'supports_tools' &&
      key !== 'source'
    ) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure provider, provider_model_id, display_name, aliases, supported_workloads, pricing, capability flags, or source.`,
      );
    }
  }
  const provider = normalizeModelRouteProviderId(
    parseStringValue(map.provider, `${pathPrefix}.provider`),
  );
  const providerModelId = parseStringValue(
    map.provider_model_id,
    `${pathPrefix}.provider_model_id`,
  );
  const aliases = parseAliasList(map.aliases, aliasId, pathPrefix);
  const recommendedAlias = parseStringValue(
    map.recommended_alias,
    `${pathPrefix}.recommended_alias`,
    aliases[0] ?? aliasId,
  );
  if (!aliases.includes(recommendedAlias)) {
    throw new Error(`${pathPrefix}.recommended_alias must be in aliases`);
  }
  return {
    provider,
    providerModelId,
    displayName: parseStringValue(
      map.display_name,
      `${pathPrefix}.display_name`,
      providerModelId,
    ),
    aliases,
    recommendedAlias,
    supportedWorkloads: parseWorkloads(map.supported_workloads, pathPrefix),
    contextWindowTokens: parseOptionalPositiveInteger(
      map.context_window_tokens,
      `${pathPrefix}.context_window_tokens`,
    ),
    maxOutputTokens: parseOptionalPositiveInteger(
      map.max_output_tokens,
      `${pathPrefix}.max_output_tokens`,
    ),
    inputUsdPerMillionTokens: parseOptionalPrice(
      map.input_usd_per_million_tokens,
      `${pathPrefix}.input_usd_per_million_tokens`,
    ),
    outputUsdPerMillionTokens: parseOptionalPrice(
      map.output_usd_per_million_tokens,
      `${pathPrefix}.output_usd_per_million_tokens`,
    ),
    cachedInputUsdPerMillionTokens: parseOptionalPrice(
      map.cached_input_usd_per_million_tokens,
      `${pathPrefix}.cached_input_usd_per_million_tokens`,
    ),
    cacheWriteUsdPerMillionTokens: parseOptionalPrice(
      map.cache_write_usd_per_million_tokens,
      `${pathPrefix}.cache_write_usd_per_million_tokens`,
    ),
    supportsThinking:
      map.supports_thinking === undefined
        ? undefined
        : parseBooleanValue(
            map.supports_thinking,
            `${pathPrefix}.supports_thinking`,
          ),
    supportsTools:
      map.supports_tools === undefined
        ? undefined
        : parseBooleanValue(map.supports_tools, `${pathPrefix}.supports_tools`),
    source: parseSource(map.source, pathPrefix, aliasId),
  };
}

function parseAliasList(
  raw: unknown,
  aliasId: string,
  pathPrefix: string,
): string[] {
  const values =
    raw === undefined
      ? [aliasId]
      : parseStringArrayValue(raw, `${pathPrefix}.aliases`);
  const aliases = [
    ...new Set([aliasId, ...values].map((alias) => alias.trim())),
  ];
  for (const alias of aliases) {
    if (alias.length === 0 || containsControlCharacter(alias)) {
      throw new Error(`${pathPrefix}.aliases must contain non-empty aliases`);
    }
  }
  return aliases;
}

function parseWorkloads(raw: unknown, pathPrefix: string): ModelWorkload[] {
  const values =
    raw === undefined
      ? ['chat', 'one_time_job', 'recurring_job']
      : parseStringArrayValue(raw, `${pathPrefix}.supported_workloads`);
  return values.map((workload, index) => {
    if (MODEL_WORKLOADS.includes(workload as ModelWorkload)) {
      return workload as ModelWorkload;
    }
    throw new Error(
      `${pathPrefix}.supported_workloads[${index}] must be one of ${MODEL_WORKLOADS.join(', ')}`,
    );
  });
}

function parseOptionalPositiveInteger(
  raw: unknown,
  pathPrefix: string,
): number | undefined {
  if (raw === undefined) return undefined;
  return parsePositiveIntegerValue(raw, pathPrefix, 1);
}

function parseOptionalPrice(
  raw: unknown,
  pathPrefix: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const value =
    typeof raw === 'string' && /^([0-9]+)(\.[0-9]+)?$/.test(raw.trim())
      ? Number(raw)
      : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${pathPrefix} must be a non-negative number`);
  }
  return value;
}

function parseSource(
  raw: unknown,
  pathPrefix: string,
  aliasId: string,
): RuntimeCustomModelAlias['source'] {
  if (raw === undefined) {
    return {
      label: `${pathPrefix}`,
      url: 'settings.yaml',
      verifiedAt: 'custom',
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix}.source must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'label' && key !== 'url' && key !== 'verified_at') {
      throw new Error(
        `${pathPrefix}.source.${key} is not supported. Configure label, url, or verified_at.`,
      );
    }
  }
  return {
    label: parseStringValue(map.label, `${pathPrefix}.source.label`, aliasId),
    url: parseStringValue(map.url, `${pathPrefix}.source.url`),
    verifiedAt: parseStringValue(
      map.verified_at,
      `${pathPrefix}.source.verified_at`,
    ),
  };
}

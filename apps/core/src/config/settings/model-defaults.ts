import {
  DEFAULT_MODEL_PROVIDER_PRESET_ID,
  isModelProviderPresetId,
  getModelProviderPreset,
  listModelProviderPresets,
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelProviderId,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import {
  applyModelProviderPreset,
  applyProviderManagedMemoryDefaults,
  loadRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeSettings,
} from './runtime-settings.js';

export type RuntimeModelDefaultConfig = {
  model?: string;
  source: string;
};

export type RuntimeModelDefaultKind =
  | 'interactive'
  | 'oneTimeJob'
  | 'recurringJob';

export type RuntimeModelDefaultResolver = (
  kind?: RuntimeModelDefaultKind,
  agentFolder?: string,
) => RuntimeModelDefaultConfig;

export type RuntimeModelDefaultSlot = {
  configuredAlias: string | null;
  effectiveAlias: string | null;
  source: string;
  workload: ModelWorkload;
  modelEntry: ModelCatalogEntry | null;
};

export type RuntimeModelDefaults = {
  defaults: {
    chat: RuntimeModelDefaultSlot;
    oneTime: RuntimeModelDefaultSlot;
    recurring: RuntimeModelDefaultSlot;
    memoryExtractor: RuntimeModelDefaultSlot;
    memoryDreaming: RuntimeModelDefaultSlot;
    memoryConsolidation: RuntimeModelDefaultSlot;
  };
};

export type RuntimeModelDefaultsPatchResult =
  | { ok: true }
  | { ok: false; message: string };

function providerFromSettings(settings: RuntimeSettings): ModelProviderId {
  const resolved = resolveModelSelectionForWorkload(
    settings.agent.defaultModel,
    'chat',
  );
  return resolved.ok
    ? resolved.entry.provider
    : DEFAULT_MODEL_PROVIDER_PRESET_ID;
}

function modelDefaultSlot(input: {
  configuredAlias?: string | null;
  effectiveAlias?: string | null;
  source: string;
  workload: ModelWorkload;
}): RuntimeModelDefaultSlot {
  const configuredAlias = input.configuredAlias?.trim() || null;
  const effectiveAlias = input.effectiveAlias?.trim() || null;
  const resolved = effectiveAlias
    ? resolveModelSelectionForWorkload(effectiveAlias, input.workload)
    : undefined;
  return {
    configuredAlias,
    effectiveAlias: resolved?.ok ? resolved.alias : effectiveAlias,
    source: input.source,
    workload: input.workload,
    modelEntry: resolved?.ok ? resolved.entry : null,
  };
}

export function readRuntimeModelDefaults(input: {
  runtimeHome: string;
  getDefaultModelConfig: RuntimeModelDefaultResolver;
}): RuntimeModelDefaults {
  const settings = loadRuntimeSettings(input.runtimeHome);
  const chat = input.getDefaultModelConfig('interactive');
  const oneTime = input.getDefaultModelConfig('oneTimeJob');
  const recurring = input.getDefaultModelConfig('recurringJob');
  return {
    defaults: {
      chat: modelDefaultSlot({
        configuredAlias: settings.agent.defaultModel || null,
        effectiveAlias: chat.model || null,
        source: chat.source,
        workload: 'chat',
      }),
      oneTime: modelDefaultSlot({
        configuredAlias: settings.agent.oneTimeJobDefaultModel || null,
        effectiveAlias: oneTime.model || null,
        source: oneTime.source,
        workload: 'one_time_job',
      }),
      recurring: modelDefaultSlot({
        configuredAlias: settings.agent.recurringJobDefaultModel || null,
        effectiveAlias: recurring.model || null,
        source: recurring.source,
        workload: 'recurring_job',
      }),
      memoryExtractor: modelDefaultSlot({
        configuredAlias: settings.memory.llm.models.extractor || null,
        effectiveAlias: settings.memory.llm.models.extractor || null,
        source: 'settings.yaml memory.llm.models.extractor',
        workload: 'memory_extractor',
      }),
      memoryDreaming: modelDefaultSlot({
        configuredAlias: settings.memory.llm.models.dreaming || null,
        effectiveAlias: settings.memory.llm.models.dreaming || null,
        source: 'settings.yaml memory.llm.models.dreaming',
        workload: 'memory_dreaming',
      }),
      memoryConsolidation: modelDefaultSlot({
        configuredAlias: settings.memory.llm.models.consolidation || null,
        effectiveAlias: settings.memory.llm.models.consolidation || null,
        source: 'settings.yaml memory.llm.models.consolidation',
        workload: 'memory_consolidation',
      }),
    },
  };
}

function applyAliasOverride(input: {
  settings: RuntimeSettings;
  body: Record<string, unknown>;
  field: string;
  workload: ModelWorkload;
  reset?(): void;
  set(alias: string): void;
}): string | undefined {
  if (!(input.field in input.body)) return undefined;
  const value = input.body[input.field];
  if (value === null) {
    if (!input.reset) return `${input.field} cannot be reset.`;
    input.reset();
    return undefined;
  }
  if (value === 'inherit') {
    if (!input.reset) return `${input.field} does not support inheritance.`;
    input.reset();
    return undefined;
  }
  if (typeof value !== 'string') {
    return `${input.field} must be a model alias or null.`;
  }
  const resolved = resolveModelSelectionForWorkload(value, input.workload);
  if (!resolved.ok) return resolved.message;
  input.set(resolved.alias);
  return undefined;
}

function providerMessage(): string {
  return `provider must be one of: ${listModelProviderPresets()
    .map((preset) => `"${preset.id}"`)
    .join(', ')}.`;
}

function applyJobsPatch(input: {
  settings: RuntimeSettings;
  value: unknown;
}): string | undefined {
  if (input.value === null || input.value === 'inherit') {
    input.settings.agent.oneTimeJobDefaultModel = '';
    input.settings.agent.recurringJobDefaultModel = '';
    return undefined;
  }
  if (typeof input.value !== 'string') {
    return 'jobs must be a model alias, "inherit", or null.';
  }
  const oneTime = resolveModelSelectionForWorkload(input.value, 'one_time_job');
  if (!oneTime.ok) return oneTime.message;
  const recurring = resolveModelSelectionForWorkload(
    input.value,
    'recurring_job',
  );
  if (!recurring.ok) return recurring.message;
  input.settings.agent.oneTimeJobDefaultModel = oneTime.alias;
  input.settings.agent.recurringJobDefaultModel = recurring.alias;
  return undefined;
}

function resetMemoryDefaults(
  settings: RuntimeSettings,
  provider: ModelProviderId,
): void {
  applyProviderManagedMemoryDefaults(settings, provider);
}

export function updateRuntimeModelDefaults(input: {
  runtimeHome: string;
  body: Record<string, unknown>;
}): RuntimeModelDefaultsPatchResult {
  const supportedFields = new Set([
    'provider',
    'chat',
    'jobs',
    'oneTime',
    'recurring',
    'memory',
  ]);
  for (const key of Object.keys(input.body)) {
    if (!supportedFields.has(key)) {
      return {
        ok: false,
        message: `Unsupported model defaults field "${key}".`,
      };
    }
  }
  const settings = loadRuntimeSettings(input.runtimeHome);
  let provider = providerFromSettings(settings);
  if ('provider' in input.body) {
    const nextProvider = input.body.provider;
    if (!isModelProviderPresetId(nextProvider)) {
      return { ok: false, message: providerMessage() };
    }
    provider = nextProvider;
    applyModelProviderPreset(settings, provider);
  }

  if ('jobs' in input.body) {
    const message = applyJobsPatch({
      settings,
      value: input.body.jobs,
    });
    if (message) return { ok: false, message };
  }

  if ('memory' in input.body) {
    const value = input.body.memory;
    if (value !== null && value !== 'reset' && value !== 'provider-managed') {
      return {
        ok: false,
        message: 'memory must be null, "reset", or "provider-managed".',
      };
    }
    resetMemoryDefaults(settings, provider);
  }

  const overrides: Array<{
    field: string;
    workload: ModelWorkload;
    reset?(): void;
    set(alias: string): void;
  }> = [
    {
      field: 'chat',
      workload: 'chat',
      reset: () => {
        settings.agent.defaultModel =
          getModelProviderPreset(provider).chatDefault;
      },
      set: (alias) => {
        settings.agent.defaultModel = alias;
      },
    },
    {
      field: 'oneTime',
      workload: 'one_time_job',
      reset: () => {
        settings.agent.oneTimeJobDefaultModel = '';
      },
      set: (alias) => {
        settings.agent.oneTimeJobDefaultModel = alias;
      },
    },
    {
      field: 'recurring',
      workload: 'recurring_job',
      reset: () => {
        settings.agent.recurringJobDefaultModel = '';
      },
      set: (alias) => {
        settings.agent.recurringJobDefaultModel = alias;
      },
    },
  ];
  for (const override of overrides) {
    const message = applyAliasOverride({
      settings,
      body: input.body,
      ...override,
    });
    if (message) return { ok: false, message };
  }
  saveRuntimeSettings(input.runtimeHome, settings);
  return { ok: true };
}

import {
  preflightModelPreset,
  type ModelPresetPreflightResult,
} from '../adapters/llm/model-preset-preflight.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  DEFAULT_SETUP_MODEL_ALIAS,
  getModelPreset,
  isModelPresetId,
  listModelCatalogEntries,
  listModelPresets,
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelPresetId,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../shared/model-cache-support.js';
import {
  applyModelPreset,
  applyPresetManagedMemoryDefaults,
  ensureRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { controlApiRequest } from './control-api.js';
type ModelCommandSettings = ReturnType<typeof ensureRuntimeSettings>;
interface ModelCommandOptions {
  preflightPreset?: (
    runtimeHome: string,
    preset: ModelPresetId,
    settings: ModelCommandSettings,
  ) => Promise<ModelPresetPreflightResult>;
}

interface ModelPreviewResponse {
  target?: string;
  jobId?: string;
  scope?: string;
  selection?: {
    effectiveAlias?: string | null;
    source?: string;
    inherited?: boolean;
    model?: {
      displayName?: string;
      responseFamily?: string;
      modelRoute?: { label?: string; metadata?: { providerModelId?: string } };
      cacheSupport?: { statusLabel?: string };
    } | null;
  };
  why?: string[];
}

function usage(): string {
  const presets = listModelPresets()
    .map((p) => p.id)
    .join('|');
  return `Usage:
  gantry model status
  gantry model list [--preset ${presets}]
  gantry model chat|jobs|memory
  gantry model set chat <alias>
  gantry model set jobs inherit|<alias>
  gantry model reset chat|jobs|memory
  gantry model why chat [group-scope|conversation-id]
  gantry model why jobs|memory|job <id>
  gantry model use-preset ${presets}
  gantry model doctor`;
}

function presetFromSettings(settings: ModelCommandSettings): ModelPresetId {
  const resolved = resolveModelSelectionForWorkload(
    settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS,
    'chat',
  );
  return resolved.ok ? resolved.entry.modelRoute.id : DEFAULT_MODEL_PRESET_ID;
}

function resolveSlot(alias: string, workload: ModelWorkload) {
  const resolved = resolveModelSelectionForWorkload(alias, workload);
  return resolved.ok
    ? `${resolved.alias} (${resolved.entry.displayName}; cache: ${resolveModelCacheSupport(resolved.entry).statusLabel})`
    : `invalid (${resolved.message})`;
}

async function preflightAliasPresets(input: {
  runtimeHome: string;
  settings: ModelCommandSettings;
  preflight: (
    runtimeHome: string,
    preset: ModelPresetId,
    settings: ModelCommandSettings,
  ) => Promise<ModelPresetPreflightResult>;
  aliases: Array<{ alias: string | undefined; workload: ModelWorkload }>;
}): Promise<boolean> {
  const presets = new Set<ModelPresetId>();
  for (const { alias, workload } of input.aliases) {
    if (!alias) continue;
    const resolved = resolveModelSelectionForWorkload(alias, workload);
    if (resolved.ok) presets.add(resolved.entry.modelRoute.id);
  }
  for (const preset of presets) {
    const result = await input.preflight(
      input.runtimeHome,
      preset,
      input.settings,
    );
    if (result.ok) continue;
    console.error(`Preset preflight failed: ${result.message}`);
    return false;
  }
  return true;
}

function chatAlias(settings: ModelCommandSettings): string {
  return settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
}

function effectiveJobAlias(
  settings: ModelCommandSettings,
  kind: 'oneTime' | 'recurring',
) {
  const explicit =
    kind === 'oneTime'
      ? settings.agent.oneTimeJobDefaultModel
      : settings.agent.recurringJobDefaultModel;
  return explicit || chatAlias(settings);
}

function defaultsFor(settings: ModelCommandSettings) {
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

function formatModelList(
  settings: ModelCommandSettings,
  preset?: ModelPresetId,
) {
  const defaults = defaultsFor(settings);
  const rows = [
    'Available model aliases',
    'Alias | Model | Response family | Route | Cache | Status',
    '--- | --- | --- | --- | --- | ---',
  ];
  for (const entry of listModelCatalogEntries()) {
    if (preset && entry.modelRoute.id !== preset) continue;
    const cacheSupport = resolveModelCacheSupport(entry);
    for (const alias of entry.aliases) {
      rows.push(
        `${alias} | ${entry.displayName} | ${entry.responseFamily} | ${entry.modelRoute.label} | ${cacheSupport.statusLabel} | ${aliasStatus(alias, entry, defaults)}`,
      );
    }
  }
  return rows.join('\n');
}

function formatAgentOverrides(settings: RuntimeSettings): string[] {
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

function formatStatus(settings: ModelCommandSettings): string {
  const preset = getModelPreset(presetFromSettings(settings));
  const oneTimeInherited = !settings.agent.oneTimeJobDefaultModel;
  const recurringInherited = !settings.agent.recurringJobDefaultModel;
  const lines = [
    'Model status',
    `preset: ${preset.id} (${preset.label})`,
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
    'memory: preset-managed',
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

function modelValidationFailures(settings: ModelCommandSettings): string[] {
  const slots: Array<{
    label: string;
    alias: string;
    workload: ModelWorkload;
  }> = [
    { label: 'chat', alias: chatAlias(settings), workload: 'chat' },
    {
      label: 'one-time',
      alias: effectiveJobAlias(settings, 'oneTime'),
      workload: 'one_time_job',
    },
    {
      label: 'recurring',
      alias: effectiveJobAlias(settings, 'recurring'),
      workload: 'recurring_job',
    },
    {
      label: 'memory extractor',
      alias: settings.memory.llm.models.extractor,
      workload: 'memory_extractor',
    },
    {
      label: 'memory dreaming',
      alias: settings.memory.llm.models.dreaming,
      workload: 'memory_dreaming',
    },
    {
      label: 'memory consolidation',
      alias: settings.memory.llm.models.consolidation,
      workload: 'memory_consolidation',
    },
  ];
  return slots.flatMap(({ label, alias, workload }) => {
    const resolved = resolveModelSelectionForWorkload(alias, workload);
    return resolved.ok ? [] : [`${label}: ${resolved.message}`];
  });
}

function selectedModelPresets(settings: ModelCommandSettings): ModelPresetId[] {
  const selected = new Set<ModelPresetId>();
  for (const { alias, workload } of [
    { alias: chatAlias(settings), workload: 'chat' as const },
    {
      alias: effectiveJobAlias(settings, 'oneTime'),
      workload: 'one_time_job' as const,
    },
    {
      alias: effectiveJobAlias(settings, 'recurring'),
      workload: 'recurring_job' as const,
    },
    {
      alias: settings.memory.llm.models.extractor,
      workload: 'memory_extractor' as const,
    },
    {
      alias: settings.memory.llm.models.dreaming,
      workload: 'memory_dreaming' as const,
    },
    {
      alias: settings.memory.llm.models.consolidation,
      workload: 'memory_consolidation' as const,
    },
  ]) {
    const resolved = resolveModelSelectionForWorkload(alias, workload);
    if (resolved.ok) selected.add(resolved.entry.modelRoute.id);
  }
  return [...selected].sort();
}

function formatTarget(
  settings: ModelCommandSettings,
  target: string,
): string | undefined {
  if (target === 'chat') {
    return [
      'Chat model',
      `${resolveSlot(chatAlias(settings), 'chat')}`,
      `source: ${settings.agent.defaultModel ? 'settings.yaml agent.default_model' : 'system default'}`,
    ].join('\n');
  }
  if (target === 'jobs') {
    return [
      'Job models',
      `one-time: ${
        settings.agent.oneTimeJobDefaultModel
          ? resolveSlot(settings.agent.oneTimeJobDefaultModel, 'one_time_job')
          : `inherits chat (${resolveSlot(chatAlias(settings), 'one_time_job')})`
      }`,
      `recurring: ${
        settings.agent.recurringJobDefaultModel
          ? resolveSlot(
              settings.agent.recurringJobDefaultModel,
              'recurring_job',
            )
          : `inherits chat (${resolveSlot(chatAlias(settings), 'recurring_job')})`
      }`,
    ].join('\n');
  }
  if (target === 'memory') {
    return [
      'Memory models',
      'mode: preset-managed',
      `extractor: ${resolveSlot(settings.memory.llm.models.extractor, 'memory_extractor')}`,
      `dreaming: ${resolveSlot(settings.memory.llm.models.dreaming, 'memory_dreaming')}`,
      `consolidation: ${resolveSlot(settings.memory.llm.models.consolidation, 'memory_consolidation')}`,
    ].join('\n');
  }
  return undefined;
}

function formatWhy(
  settings: ModelCommandSettings,
  target: string,
): string | undefined {
  if (target === 'chat') {
    return [
      'Why chat uses this model',
      `chat: ${resolveSlot(chatAlias(settings), 'chat')}`,
      settings.agent.defaultModel
        ? 'reason: settings.yaml agent.default_model is set'
        : 'reason: no chat default is set, so Gantry uses the system default',
    ].join('\n');
  }
  if (target === 'jobs') {
    return [
      'Why jobs use these models',
      settings.agent.oneTimeJobDefaultModel
        ? `one-time: explicit ${resolveSlot(settings.agent.oneTimeJobDefaultModel, 'one_time_job')}`
        : `one-time: inherits chat (${resolveSlot(chatAlias(settings), 'one_time_job')})`,
      settings.agent.recurringJobDefaultModel
        ? `recurring: explicit ${resolveSlot(settings.agent.recurringJobDefaultModel, 'recurring_job')}`
        : `recurring: inherits chat (${resolveSlot(chatAlias(settings), 'recurring_job')})`,
    ].join('\n');
  }
  if (target === 'memory') {
    return [
      'Why memory uses these models',
      'reason: memory is preset-managed and follows the selected preset',
      `extractor: ${resolveSlot(settings.memory.llm.models.extractor, 'memory_extractor')}`,
      `dreaming: ${resolveSlot(settings.memory.llm.models.dreaming, 'memory_dreaming')}`,
      `consolidation: ${resolveSlot(settings.memory.llm.models.consolidation, 'memory_consolidation')}`,
    ].join('\n');
  }
  return undefined;
}

function formatPreviewWhy(preview: ModelPreviewResponse): string {
  const selection = preview.selection;
  const modelLabel = selection?.model?.displayName
    ? `${selection.effectiveAlias ?? '(none)'} (${selection.model.displayName})`
    : (selection?.effectiveAlias ?? '(none)');
  const target = preview.jobId
    ? `job ${preview.jobId}`
    : preview.scope
      ? `${preview.target ?? 'model'} ${preview.scope}`
      : (preview.target ?? 'model');
  const lines = [
    `Why ${target} uses this model`,
    `model: ${modelLabel}`,
    `source: ${selection?.source ?? 'unknown'}`,
    `mode: ${selection?.inherited ? 'inherited' : 'explicit'}`,
  ];
  if (selection?.model?.responseFamily)
    lines.push(`response family: ${selection.model.responseFamily}`);
  if (selection?.model?.modelRoute?.label)
    lines.push(`route: ${selection.model.modelRoute.label}`);
  if (selection?.model?.modelRoute?.metadata?.providerModelId) {
    lines.push(
      `provider model id: ${selection.model.modelRoute.metadata.providerModelId}`,
    );
  }
  if (selection?.model?.cacheSupport?.statusLabel) {
    lines.push(`cache: ${selection.model.cacheSupport.statusLabel}`);
  }
  if (preview.why?.length) {
    lines.push(...preview.why.map((reason) => `reason: ${reason}`));
  }
  return lines.join('\n');
}

function parsePresetFlag(args: string[]): ModelPresetId | undefined {
  const value = args.find((arg) => arg.startsWith('--preset='));
  const preset = value
    ? value.slice('--preset='.length)
    : args.includes('--preset')
      ? args[args.indexOf('--preset') + 1]
      : undefined;
  return isModelPresetId(preset) ? preset : undefined;
}

export async function runModelCommand(
  runtimeHome: string,
  args: string[],
  options: ModelCommandOptions = {},
): Promise<number> {
  const [action, target, alias] = args;
  const settings = ensureRuntimeSettings(runtimeHome);
  const preflight =
    options.preflightPreset ??
    ((runtimeHome, preset, settings) =>
      preflightModelPreset({ runtimeHome, preset, settings }));

  if (!action || action === 'status') {
    console.log(formatStatus(settings));
    return 0;
  }

  if (action === 'list') {
    console.log(formatModelList(settings, parsePresetFlag(args.slice(1))));
    return 0;
  }

  if (action === 'chat' || action === 'jobs' || action === 'memory') {
    console.log(formatTarget(settings, action));
    return 0;
  }

  if (action === 'set') {
    if (target === 'chat' && alias) {
      const resolved = resolveModelSelectionForWorkload(alias, 'chat');
      if (!resolved.ok) {
        console.error(resolved.message);
        return 1;
      }
      if (
        !(await preflightAliasPresets({
          runtimeHome,
          settings,
          preflight,
          aliases: [{ alias: resolved.alias, workload: 'chat' }],
        }))
      ) {
        return 1;
      }
      settings.agent.defaultModel = resolved.alias;
      saveRuntimeSettings(runtimeHome, settings);
      console.log(`chat: ${resolved.alias} (${resolved.entry.displayName})`);
      return 0;
    }
    if (target === 'jobs' && alias) {
      if (alias === 'inherit') {
        if (
          !(await preflightAliasPresets({
            runtimeHome,
            settings,
            preflight,
            aliases: [
              { alias: chatAlias(settings), workload: 'one_time_job' },
              { alias: chatAlias(settings), workload: 'recurring_job' },
            ],
          }))
        ) {
          return 1;
        }
        settings.agent.oneTimeJobDefaultModel = '';
        settings.agent.recurringJobDefaultModel = '';
        saveRuntimeSettings(runtimeHome, settings);
        console.log(`one-time: inherits chat (${chatAlias(settings)})`);
        console.log(`recurring: inherits chat (${chatAlias(settings)})`);
        return 0;
      }
      const oneTime = resolveModelSelectionForWorkload(alias, 'one_time_job');
      if (!oneTime.ok) {
        console.error(oneTime.message);
        return 1;
      }
      const recurring = resolveModelSelectionForWorkload(
        alias,
        'recurring_job',
      );
      if (!recurring.ok) {
        console.error(recurring.message);
        return 1;
      }
      if (
        !(await preflightAliasPresets({
          runtimeHome,
          settings,
          preflight,
          aliases: [
            { alias: oneTime.alias, workload: 'one_time_job' },
            { alias: recurring.alias, workload: 'recurring_job' },
          ],
        }))
      ) {
        return 1;
      }
      settings.agent.oneTimeJobDefaultModel = oneTime.alias;
      settings.agent.recurringJobDefaultModel = recurring.alias;
      saveRuntimeSettings(runtimeHome, settings);
      console.log(`one-time: ${oneTime.alias} (${oneTime.entry.displayName})`);
      console.log(
        `recurring: ${recurring.alias} (${recurring.entry.displayName})`,
      );
      return 0;
    }
    console.error(usage());
    return 1;
  }

  if (action === 'reset') {
    const presetId = presetFromSettings(settings);
    const preset = getModelPreset(presetId);
    const aliases =
      target === 'chat'
        ? [{ alias: preset.chatDefault, workload: 'chat' as const }]
        : target === 'jobs'
          ? [
              { alias: chatAlias(settings), workload: 'one_time_job' as const },
              {
                alias: chatAlias(settings),
                workload: 'recurring_job' as const,
              },
            ]
          : target === 'memory'
            ? [
                {
                  alias: preset.memoryDefaults.extractor,
                  workload: 'memory_extractor' as const,
                },
                {
                  alias: preset.memoryDefaults.dreaming,
                  workload: 'memory_dreaming' as const,
                },
                {
                  alias: preset.memoryDefaults.consolidation,
                  workload: 'memory_consolidation' as const,
                },
              ]
            : undefined;
    if (!aliases) {
      console.error(usage());
      return 1;
    }
    if (
      !(await preflightAliasPresets({
        runtimeHome,
        settings,
        preflight,
        aliases,
      }))
    ) {
      return 1;
    }
    if (target === 'chat') {
      settings.agent.defaultModel = preset.chatDefault;
    } else if (target === 'jobs') {
      settings.agent.oneTimeJobDefaultModel = '';
      settings.agent.recurringJobDefaultModel = '';
    } else if (target === 'memory') {
      applyPresetManagedMemoryDefaults(settings, presetId);
    }
    saveRuntimeSettings(runtimeHome, settings);
    console.log(formatTarget(settings, target));
    return 0;
  }

  if (action === 'why') {
    if (target === 'chat' && alias) {
      try {
        const preview = (await controlApiRequest(runtimeHome, {
          method: 'POST',
          path: '/v1/models/preview',
          body: {
            target: 'chat',
            ...(alias.includes(':')
              ? { conversationJid: alias }
              : { groupScope: alias }),
          },
        })) as ModelPreviewResponse;
        console.log(formatPreviewWhy(preview));
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    if (target === 'job') {
      if (!alias) {
        console.error(usage());
        return 1;
      }
      try {
        const preview = (await controlApiRequest(runtimeHome, {
          method: 'POST',
          path: '/v1/models/preview',
          body: { target: 'job', jobId: alias },
        })) as ModelPreviewResponse;
        console.log(formatPreviewWhy(preview));
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    const output = target ? formatWhy(settings, target) : undefined;
    if (!output) {
      console.error(usage());
      return 1;
    }
    console.log(output);
    return 0;
  }

  if (action === 'use-preset') {
    if (!isModelPresetId(target)) {
      console.error(usage());
      return 1;
    }
    const result = await preflight(runtimeHome, target, settings);
    if (!result.ok) {
      console.error(`Preset preflight failed: ${result.message}`);
      return 1;
    }
    applyModelPreset(settings, target);
    saveRuntimeSettings(runtimeHome, settings);
    console.log(`preset: ${target}`);
    console.log(`chat: ${settings.agent.defaultModel}`);
    console.log(`one-time: inherits chat (${settings.agent.defaultModel})`);
    console.log(`recurring: inherits chat (${settings.agent.defaultModel})`);
    console.log('memory: preset-managed');
    return 0;
  }

  if (action === 'doctor') {
    const preset = presetFromSettings(settings);
    const validationFailures = modelValidationFailures(settings);
    const preflightResults =
      validationFailures.length === 0
        ? await Promise.all(
            selectedModelPresets(settings).map(async (selectedPreset) => ({
              preset: selectedPreset,
              result: await preflight(runtimeHome, selectedPreset, settings),
            })),
          )
        : [];
    const status =
      validationFailures.length === 0 &&
      preflightResults.every(({ result }) => result.ok)
        ? 'pass'
        : 'fail';
    console.log(
      [
        'Model doctor',
        formatStatus(settings),
        validationFailures.length === 0
          ? 'model aliases: pass'
          : `model aliases: fail - ${validationFailures.join('; ')}`,
        `preset health: ${preset}`,
        ...(preflightResults.length > 0
          ? preflightResults.map(({ preset, result }) => {
              const label = getModelPreset(preset).label;
              return `${label} credentials: ${result.status} - ${result.message}`;
            })
          : ['preset credentials: skipped - Model aliases are invalid.']),
        `Status: ${status}`,
      ].join('\n'),
    );
    return status === 'pass' ? 0 : 1;
  }

  console.error(usage());
  return 1;
}

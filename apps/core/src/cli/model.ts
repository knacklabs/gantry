import {
  preflightModelPreset,
  type ModelPresetPreflightResult,
} from '../adapters/llm/model-preset-preflight.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  DEFAULT_SETUP_MODEL_ALIAS,
  getModelPreset,
  isModelPresetId,
  listModelPresets,
  resolveModelSelection,
  resolveModelSelectionForWorkload,
  type ModelPresetId,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../shared/model-cache-support.js';
import {
  isModelFamilyAlias,
  resolveModelSelectionForWorkloadWithFamilies,
} from '../shared/model-families.js';
import { formatModelWhy } from '../shared/model-why-format.js';
import {
  familyOrderFromSettings,
  fetchConfiguredProviders,
  formatModelList,
} from './model-list-format.js';
import { providerLabel } from '../shared/model-catalog-availability.js';
import {
  applyModelPreset,
  applyPresetManagedMemoryDefaults,
  ensureRuntimeSettings,
  writeDesiredRuntimeSettings,
  type RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { controlApiRequest } from './control-api.js';
import type { ModelPreviewResponse } from './model-preview-types.js';
import { formatPreviewWhy, parseAgentFlag } from './model-preview-format.js';
type ModelCommandSettings = ReturnType<typeof ensureRuntimeSettings>;
interface ModelCommandOptions {
  preflightPreset?: (
    runtimeHome: string,
    preset: ModelPresetId,
    settings: ModelCommandSettings,
  ) => Promise<ModelPresetPreflightResult>;
}

function usage(): string {
  const presets = listModelPresets()
    .map((p) => p.id)
    .join('|');
  return `Usage:
  gantry model status
  gantry model list [--preset ${presets}]
  gantry model chat|jobs|memory
  gantry model set chat <alias|family>
  gantry model set jobs inherit|<alias|family>
  gantry model reset chat|jobs|memory
  gantry model why chat [group-scope|conversation-id]
  gantry model why jobs|memory|job <id>
  gantry model why <alias|family>
  gantry model why <alias> --agent <id>
  gantry model use-preset ${presets}
  gantry model doctor`;
}

function presetFromSettings(settings: ModelCommandSettings): ModelPresetId {
  const resolved = resolveModelSelectionForWorkload(
    settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS,
    'chat',
  );
  // modelRoute.id is the provider id, which is only a preset id for the
  // anthropic/openrouter lanes. DeepAgents-lane providers (openai/groq/...) have
  // no preset, so fall back to the default preset to avoid getModelPreset throws.
  const providerId = resolved.ok ? resolved.entry.modelRoute.id : undefined;
  return isModelPresetId(providerId) ? providerId : DEFAULT_MODEL_PRESET_ID;
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
    if (resolved.ok && isModelPresetId(resolved.entry.modelRoute.id)) {
      presets.add(resolved.entry.modelRoute.id);
    }
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

// Best-effort note when a freshly selected concrete non-preset model has no
// active credential, so `set` surfaces the missing key immediately instead of
// only at run time. Skips silently when the control API is unreachable (the
// global `gantry doctor` credential check still catches it).
async function noteUnconfiguredProvider(
  runtimeHome: string,
  alias: string,
  providerId: string,
): Promise<void> {
  if (isModelFamilyAlias(alias) || isModelPresetId(providerId)) return;
  const configured = await fetchConfiguredProviders(runtimeHome);
  if (!configured || configured.has(providerId)) return;
  console.warn(
    `Note: ${alias} runs on the ${providerLabel(providerId)} provider, which has no active credential. Run \`gantry credentials model set ${providerId}\` to use it.`,
  );
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
    // Only anthropic/openrouter provider ids are preset ids; DeepAgents-lane
    // providers have no preset to preflight, so skip them here.
    if (resolved.ok && isModelPresetId(resolved.entry.modelRoute.id)) {
      selected.add(resolved.entry.modelRoute.id);
    }
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

  const persistSettings = async (
    previousSettings: RuntimeSettings,
    nextSettings: RuntimeSettings,
  ) => {
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings: nextSettings,
      previousSettings,
    });
  };

  if (!action || action === 'status') {
    console.log(formatStatus(settings));
    return 0;
  }

  if (action === 'list') {
    const configuredProviders = await fetchConfiguredProviders(runtimeHome);
    console.log(
      formatModelList(settings, parsePresetFlag(args.slice(1)), {
        configuredProviders,
        familyOrder: familyOrderFromSettings(settings),
      }),
    );
    return 0;
  }

  if (action === 'chat' || action === 'jobs' || action === 'memory') {
    console.log(formatTarget(settings, action));
    return 0;
  }

  if (action === 'set') {
    const familyOrder = familyOrderFromSettings(settings);
    if (target === 'chat' && alias) {
      // Family aliases (e.g. gpt-oss) are accepted and stored verbatim; the
      // concrete provider is picked at spawn from the configured credential.
      const resolved = resolveModelSelectionForWorkloadWithFamilies(
        alias,
        'chat',
        familyOrder,
      );
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
      const previousSettings = structuredClone(settings);
      settings.agent.defaultModel = resolved.alias;
      await persistSettings(previousSettings, settings);
      console.log(`chat: ${resolved.alias} (${resolved.entry.displayName})`);
      await noteUnconfiguredProvider(
        runtimeHome,
        resolved.alias,
        resolved.entry.modelRoute.id,
      );
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
        const previousSettings = structuredClone(settings);
        settings.agent.oneTimeJobDefaultModel = '';
        settings.agent.recurringJobDefaultModel = '';
        await persistSettings(previousSettings, settings);
        console.log(`one-time: inherits chat (${chatAlias(settings)})`);
        console.log(`recurring: inherits chat (${chatAlias(settings)})`);
        return 0;
      }
      const oneTime = resolveModelSelectionForWorkloadWithFamilies(
        alias,
        'one_time_job',
        familyOrder,
      );
      if (!oneTime.ok) {
        console.error(oneTime.message);
        return 1;
      }
      const recurring = resolveModelSelectionForWorkloadWithFamilies(
        alias,
        'recurring_job',
        familyOrder,
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
      const previousSettings = structuredClone(settings);
      settings.agent.oneTimeJobDefaultModel = oneTime.alias;
      settings.agent.recurringJobDefaultModel = recurring.alias;
      await persistSettings(previousSettings, settings);
      console.log(`one-time: ${oneTime.alias} (${oneTime.entry.displayName})`);
      console.log(
        `recurring: ${recurring.alias} (${recurring.entry.displayName})`,
      );
      await noteUnconfiguredProvider(
        runtimeHome,
        oneTime.alias,
        oneTime.entry.modelRoute.id,
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
    const previousSettings = structuredClone(settings);
    if (target === 'chat') {
      settings.agent.defaultModel = preset.chatDefault;
    } else if (target === 'jobs') {
      settings.agent.oneTimeJobDefaultModel = '';
      settings.agent.recurringJobDefaultModel = '';
    } else if (target === 'memory') {
      applyPresetManagedMemoryDefaults(settings, presetId);
    }
    await persistSettings(previousSettings, settings);
    console.log(formatTarget(settings, target));
    return 0;
  }

  if (action === 'why') {
    // `gantry model why <alias> --agent <id>` resolves a model alias against an
    // agent's selected harness and shows the endpoint family, credential
    // profile, agent harness, and diagnostic executionProviderId for the
    // resolved route. Incompatibility surfaces the locked copy, not a stack.
    const agentId = parseAgentFlag(args);
    if (agentId !== undefined) {
      if (!target || !agentId) {
        console.error(usage());
        return 1;
      }
      try {
        const preview = (await controlApiRequest(runtimeHome, {
          method: 'POST',
          path: '/v1/models/preview',
          body: { target: 'agent', agentId, modelAlias: target },
        })) as ModelPreviewResponse;
        console.log(formatPreviewWhy(preview));
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    if (target === 'chat' && alias) {
      try {
        const preview = (await controlApiRequest(runtimeHome, {
          method: 'POST',
          path: '/v1/models/preview',
          body: {
            target: 'chat',
            ...(alias.includes(':')
              ? { conversationJid: alias }
              : { workspaceKey: alias }),
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
    // `gantry model why <alias|family>`: family-aware resolution preview. A
    // family shows members in effective order, the provider it would resolve to
    // for the configured set, and the reason; a concrete alias shows whether its
    // provider key is configured. Degrades to no configured/needs-key line when
    // the control API is unreachable.
    if (
      target &&
      !alias &&
      (isModelFamilyAlias(target) || resolveModelSelection(target).ok)
    ) {
      const configuredProviders = await fetchConfiguredProviders(runtimeHome);
      console.log(
        formatModelWhy({
          value: target,
          configuredProviders,
          familyOrder: familyOrderFromSettings(settings),
        }),
      );
      return 0;
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
    const previousSettings = structuredClone(settings);
    applyModelPreset(settings, target);
    await persistSettings(previousSettings, settings);
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

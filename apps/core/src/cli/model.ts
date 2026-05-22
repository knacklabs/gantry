import {
  preflightModelProvider,
  type ProviderPreflightResult,
} from '../adapters/llm/model-provider-preflight.js';
import {
  DEFAULT_MODEL_PROVIDER_PRESET_ID,
  DEFAULT_SETUP_MODEL_ALIAS,
  getModelProviderPreset,
  isModelProviderPresetId,
  listModelCatalogEntries,
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelProviderId,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import {
  applyModelProviderPreset,
  applyProviderManagedMemoryDefaults,
  ensureRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { controlApiRequest } from './control-api.js';

type ModelCommandSettings = ReturnType<typeof ensureRuntimeSettings>;

interface ModelCommandOptions {
  preflightProvider?: (
    runtimeHome: string,
    provider: ModelProviderId,
    settings: ModelCommandSettings,
  ) => Promise<ProviderPreflightResult>;
}

interface ModelPreviewResponse {
  target?: string;
  jobId?: string;
  scope?: string;
  kind?: string;
  task?: string;
  selection?: {
    effectiveAlias?: string | null;
    source?: string;
    inherited?: boolean;
    model?: {
      displayName?: string;
      provider?: string;
      providerSlug?: string;
    } | null;
  };
  why?: string[];
}

function usage(): string {
  return [
    'Usage:',
    '  gantry model status',
    '  gantry model list [--provider anthropic|openrouter]',
    '  gantry model chat|jobs|memory',
    '  gantry model set chat <alias>',
    '  gantry model set jobs inherit|<alias>',
    '  gantry model reset chat|jobs|memory',
    '  gantry model why chat [group-scope|conversation-id]',
    '  gantry model why jobs|memory|job <id>',
    '  gantry model use-provider anthropic|openrouter',
    '  gantry model doctor',
  ].join('\n');
}

function providerFromSettings(settings: ModelCommandSettings): ModelProviderId {
  const resolved = resolveModelSelectionForWorkload(
    settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS,
    'chat',
  );
  return resolved.ok
    ? resolved.entry.provider
    : DEFAULT_MODEL_PROVIDER_PRESET_ID;
}

function resolveSlot(alias: string, workload: ModelWorkload) {
  const resolved = resolveModelSelectionForWorkload(alias, workload);
  return resolved.ok
    ? `${resolved.alias} (${resolved.entry.displayName})`
    : `invalid (${resolved.message})`;
}

function validateSlot(
  alias: string,
  workload: ModelWorkload,
): string | undefined {
  const resolved = resolveModelSelectionForWorkload(alias, workload);
  return resolved.ok ? undefined : resolved.message;
}

async function preflightAliasProviders(input: {
  runtimeHome: string;
  settings: ModelCommandSettings;
  preflight: (
    runtimeHome: string,
    provider: ModelProviderId,
    settings: ModelCommandSettings,
  ) => Promise<ProviderPreflightResult>;
  aliases: Array<{ alias: string | undefined; workload: ModelWorkload }>;
}): Promise<boolean> {
  const providers = new Set<ModelProviderId>();
  for (const { alias, workload } of input.aliases) {
    if (!alias) continue;
    const resolved = resolveModelSelectionForWorkload(alias, workload);
    if (resolved.ok) providers.add(resolved.entry.provider);
  }
  for (const provider of providers) {
    const result = await input.preflight(
      input.runtimeHome,
      provider,
      input.settings,
    );
    if (result.ok) continue;
    console.error(`Provider preflight failed: ${result.message}`);
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
  if (defaults.memoryConsolidation === alias) {
    statuses.push('memory consolidation');
  }
  return statuses.join(', ');
}

function formatModelList(
  settings: ModelCommandSettings,
  provider?: ModelProviderId,
): string {
  const defaults = defaultsFor(settings);
  const rows = [
    'Available model aliases',
    'Alias | Model | Provider | Provider slug | Status',
    '--- | --- | --- | --- | ---',
  ];
  for (const entry of listModelCatalogEntries()) {
    if (provider && entry.provider !== provider) continue;
    for (const alias of entry.aliases) {
      rows.push(
        `${alias} | ${entry.displayName} | ${entry.providerLabel} | ${entry.providerModelId} | ${aliasStatus(alias, entry, defaults)}`,
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
  const provider = getModelProviderPreset(providerFromSettings(settings));
  const oneTimeInherited = !settings.agent.oneTimeJobDefaultModel;
  const recurringInherited = !settings.agent.recurringJobDefaultModel;
  const lines = [
    'Model status',
    `provider: ${provider.id} (${provider.label})`,
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
    'memory: provider-managed',
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
    const message = validateSlot(alias, workload);
    return message ? [`${label}: ${message}`] : [];
  });
}

function selectedModelProviders(
  settings: ModelCommandSettings,
): ModelProviderId[] {
  const selected = new Set<ModelProviderId>();
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
    if (resolved.ok) selected.add(resolved.entry.provider);
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
      'mode: provider-managed',
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
      'reason: memory is provider-managed and follows the selected provider',
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
  if (selection?.model?.provider)
    lines.push(`provider: ${selection.model.provider}`);
  if (selection?.model?.providerSlug) {
    lines.push(`provider slug: ${selection.model.providerSlug}`);
  }
  if (preview.why?.length) {
    lines.push(...preview.why.map((reason) => `reason: ${reason}`));
  }
  return lines.join('\n');
}

function parseProviderFlag(args: string[]): ModelProviderId | undefined {
  const value = args.find((arg) => arg.startsWith('--provider='));
  const provider =
    value?.slice('--provider='.length) ??
    (args.includes('--provider')
      ? args[args.indexOf('--provider') + 1]
      : undefined);
  return isModelProviderPresetId(provider) ? provider : undefined;
}

export async function runModelCommand(
  runtimeHome: string,
  args: string[],
  options: ModelCommandOptions = {},
): Promise<number> {
  const [action, target, alias] = args;
  const settings = ensureRuntimeSettings(runtimeHome);
  const preflight =
    options.preflightProvider ??
    ((runtimeHome, provider, settings) =>
      preflightModelProvider({ runtimeHome, provider, settings }));

  if (!action || action === 'status') {
    console.log(formatStatus(settings));
    return 0;
  }

  if (action === 'list') {
    console.log(formatModelList(settings, parseProviderFlag(args.slice(1))));
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
        !(await preflightAliasProviders({
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
          !(await preflightAliasProviders({
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
        !(await preflightAliasProviders({
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
    const provider = providerFromSettings(settings);
    const preset = getModelProviderPreset(provider);
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
      !(await preflightAliasProviders({
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
      applyProviderManagedMemoryDefaults(settings, provider);
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

  if (action === 'use-provider') {
    if (!isModelProviderPresetId(target)) {
      console.error(usage());
      return 1;
    }
    const result = await preflight(runtimeHome, target, settings);
    if (!result.ok) {
      console.error(`Provider preflight failed: ${result.message}`);
      return 1;
    }
    applyModelProviderPreset(settings, target);
    saveRuntimeSettings(runtimeHome, settings);
    console.log(`provider: ${target}`);
    console.log(`chat: ${settings.agent.defaultModel}`);
    console.log(`one-time: inherits chat (${settings.agent.defaultModel})`);
    console.log(`recurring: inherits chat (${settings.agent.defaultModel})`);
    console.log('memory: provider-managed');
    return 0;
  }

  if (action === 'doctor') {
    const provider = providerFromSettings(settings);
    const validationFailures = modelValidationFailures(settings);
    const preflightResults =
      validationFailures.length === 0
        ? await Promise.all(
            selectedModelProviders(settings).map(async (selectedProvider) => ({
              provider: selectedProvider,
              result: await preflight(runtimeHome, selectedProvider, settings),
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
        `provider health: ${provider}`,
        ...(preflightResults.length > 0
          ? preflightResults.map(({ provider, result }) => {
              const label = getModelProviderPreset(provider).label;
              return `${label} credentials: ${result.status} - ${result.message}`;
            })
          : ['provider credentials: skipped - Model aliases are invalid.']),
        `Status: ${status}`,
      ].join('\n'),
    );
    return status === 'pass' ? 0 : 1;
  }

  console.error(usage());
  return 1;
}

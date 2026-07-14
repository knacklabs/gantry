import {
  preflightModelProvider,
  type ModelProviderPreflightResult,
} from '../adapters/llm/model-provider-preflight.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  memoryModelDefaultsForProvider,
  resolveModelSelection,
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import {
  isModelFamilyAlias,
  resolveModelFamilyAlias,
  resolveModelSelectionForWorkloadWithFamilies,
} from '../shared/model-families.js';
import { formatModelWhy } from '../shared/model-why-format.js';
import {
  chatAlias,
  configuredProviderIdsForCli,
  effectiveJobAlias,
  familyOrderFromSettings,
  fetchConfiguredProviders,
  formatModelList,
  formatModelStatus,
  memoryProviderFromSettings,
  memoryResetProviderFromSettings,
  providerForAlias,
  providerFromSettings,
  resolveSlot,
} from './model-list-format.js';
import { providerLabel } from '../shared/model-catalog-availability.js';
import {
  applyProviderManagedMemoryDefaults,
  ensureRuntimeSettings,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
  type RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { controlApiRequest } from './control-api.js';
import type { ModelPreviewResponse } from './model-preview-types.js';
import { formatPreviewWhy, parseAgentFlag } from './model-preview-format.js';
type ModelCommandSettings = ReturnType<typeof ensureRuntimeSettings>;
interface ModelCommandOptions {
  preflightProvider?: (
    runtimeHome: string,
    providerId: string,
    settings: ModelCommandSettings,
    chatAlias?: string,
  ) => Promise<ModelProviderPreflightResult>;
}

function usage(): string {
  return `Usage:
  gantry model status
  gantry model list [--provider <id>]
  gantry model chat|jobs|memory
  gantry model set chat <alias|family>
  gantry model set chat <alias> --agent <id>
  gantry model set jobs inherit|<alias|family>
  gantry model reset chat|jobs|memory
  gantry model why chat [group-scope|conversation-id]
  gantry model why jobs|memory|job <id>
  gantry model why <alias|family>
  gantry model why <alias> --agent <id>
  gantry model doctor`;
}

async function preflightAliasProviders(input: {
  runtimeHome: string;
  settings: ModelCommandSettings;
  preflight: (
    runtimeHome: string,
    providerId: string,
    settings: ModelCommandSettings,
    chatAlias?: string,
  ) => Promise<ModelProviderPreflightResult>;
  aliases: Array<{ alias: string | undefined; workload: ModelWorkload }>;
}): Promise<boolean> {
  const providers = new Map<string, string | undefined>();
  // Family aliases preflight the same member the runtime would choose: the
  // first member whose provider has a configured credential, falling back to
  // the first member when none are (or the control API is unreachable).
  const hasFamilyAlias = input.aliases.some(
    ({ alias }) => alias && isModelFamilyAlias(alias),
  );
  const configuredProviders = hasFamilyAlias
    ? await configuredProviderIdsForCli(input.runtimeHome)
    : undefined;
  const familyOrder = familyOrderFromSettings(input.settings);
  for (const { alias, workload } of input.aliases) {
    if (!alias) continue;
    const concreteInput = isModelFamilyAlias(alias)
      ? (resolveModelFamilyAlias(alias, {
          isProviderConfigured: (providerId) =>
            configuredProviders?.has(providerId) ?? false,
          order: familyOrder,
        })?.alias ?? alias)
      : alias;
    const resolved = resolveModelSelectionForWorkload(concreteInput, workload);
    if (resolved.ok) {
      const providerId = resolved.entry.modelRoute.id;
      providers.set(
        providerId,
        workload === 'chat' ? resolved.alias : providers.get(providerId),
      );
    }
  }
  for (const [providerId, chatAlias] of providers) {
    const result = await input.preflight(
      input.runtimeHome,
      providerId,
      input.settings,
      chatAlias,
    );
    if (result.ok) continue;
    console.error(`Provider preflight failed: ${result.message}`);
    return false;
  }
  return true;
}

async function noteUnconfiguredProvider(
  runtimeHome: string,
  alias: string,
  providerId: string,
): Promise<void> {
  if (isModelFamilyAlias(alias)) return;
  const configured = await fetchConfiguredProviders(runtimeHome);
  if (!configured || configured.has(providerId)) return;
  console.warn(
    `Note: ${alias} runs on the ${providerLabel(providerId)} provider, which has no active credential. Run \`gantry credentials model set ${providerId}\` to use it.`,
  );
}

async function noteUnconfiguredMemoryProviders(
  runtimeHome: string,
  settings: ModelCommandSettings,
): Promise<void> {
  const { extractor, dreaming, consolidation } = settings.memory.llm.models;
  for (const [alias, workload] of [
    [extractor, 'memory_extractor'],
    [dreaming, 'memory_dreaming'],
    [consolidation, 'memory_consolidation'],
  ] as const) {
    const providerId = providerForAlias(alias, workload);
    if (providerId)
      await noteUnconfiguredProvider(runtimeHome, alias, providerId);
  }
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

function selectedModelProviders(settings: ModelCommandSettings): string[] {
  const selected = new Set<string>();
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
      `mode: provider-managed (from ${memoryProviderFromSettings(settings)})`,
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
      `reason: memory is provider-managed from ${memoryProviderFromSettings(settings)}`,
      `extractor: ${resolveSlot(settings.memory.llm.models.extractor, 'memory_extractor')}`,
      `dreaming: ${resolveSlot(settings.memory.llm.models.dreaming, 'memory_dreaming')}`,
      `consolidation: ${resolveSlot(settings.memory.llm.models.consolidation, 'memory_consolidation')}`,
    ].join('\n');
  }
  return undefined;
}

function parseProviderFlag(args: string[]): string | undefined {
  const value = args.find((arg) => arg.startsWith('--provider='));
  return value
    ? value.slice('--provider='.length)
    : args.includes('--provider')
      ? args[args.indexOf('--provider') + 1]
      : undefined;
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
    ((runtimeHome, providerId, settings, chatAlias) =>
      preflightModelProvider({
        runtimeHome,
        providerId,
        chatAlias,
        settings,
      }));

  const persistSettings = async (
    previousSettings: RuntimeSettings,
    nextSettings: RuntimeSettings,
  ) => {
    return writeDesiredRuntimeSettings({
      runtimeHome,
      settings: nextSettings,
      previousSettings,
    });
  };

  if (!action || action === 'status') {
    console.log(formatModelStatus(settings));
    return 0;
  }

  if (action === 'list') {
    const configuredProviders = await fetchConfiguredProviders(runtimeHome);
    console.log(
      formatModelList(settings, parseProviderFlag(args.slice(1)), {
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
      const agentId = parseAgentFlag(args);
      if (agentId !== undefined) {
        if (!agentId) {
          console.error(usage());
          return 1;
        }
        const resolved = resolveModelSelectionForWorkload(alias, 'chat');
        if (!resolved.ok) {
          console.error(resolved.message);
          return 1;
        }
        if (!settings.agents[agentId]) {
          console.error(`Unknown agent: ${agentId}`);
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
        const previousSettings = structuredClone(settings);
        settings.agents[agentId].model = resolved.alias;
        const writeResult = await persistSettings(previousSettings, settings);
        console.log(
          `agent ${agentId} chat: ${resolved.alias} (${resolved.entry.displayName})`,
        );
        noteRestartRequired(writeResult);
        await noteUnconfiguredProvider(
          runtimeHome,
          resolved.alias,
          resolved.entry.modelRoute.id,
        );
        return 0;
      }
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
        !(await preflightAliasProviders({
          runtimeHome,
          settings,
          preflight,
          aliases: [{ alias: resolved.alias, workload: 'chat' }],
        }))
      ) {
        return 1;
      }
      const oldMemoryProvider = memoryProviderFromSettings(settings);
      const previousSettings = structuredClone(settings);
      settings.agent.defaultModel = resolved.alias;
      await persistSettings(previousSettings, settings);
      console.log(`chat: ${resolved.alias} (${resolved.entry.displayName})`);
      await noteUnconfiguredProvider(
        runtimeHome,
        resolved.alias,
        resolved.entry.modelRoute.id,
      );
      // Compare against the provider `reset memory` would actually target —
      // for a family alias that is the credential-selected member, not the
      // first member borrowed by the resolver's entry.
      const newMemoryProvider = await memoryResetProviderFromSettings(
        runtimeHome,
        settings,
      );
      if (oldMemoryProvider !== newMemoryProvider) {
        console.warn(
          `Memory models still on ${oldMemoryProvider} — run \`gantry model reset memory\` to re-derive.`,
        );
      }
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
      if (recurring.entry.modelRoute.id !== oneTime.entry.modelRoute.id) {
        await noteUnconfiguredProvider(
          runtimeHome,
          recurring.alias,
          recurring.entry.modelRoute.id,
        );
      }
      return 0;
    }
    console.error(usage());
    return 1;
  }

  if (action === 'reset') {
    const memoryProviderId =
      target === 'memory'
        ? await memoryResetProviderFromSettings(runtimeHome, settings)
        : providerFromSettings(settings);
    const memoryDefaults = memoryModelDefaultsForProvider(memoryProviderId);
    const aliases =
      target === 'chat'
        ? [{ alias: DEFAULT_SETUP_MODEL_ALIAS, workload: 'chat' as const }]
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
                  alias: memoryDefaults.extractor,
                  workload: 'memory_extractor' as const,
                },
                {
                  alias: memoryDefaults.dreaming,
                  workload: 'memory_dreaming' as const,
                },
                {
                  alias: memoryDefaults.consolidation,
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
    const previousSettings = structuredClone(settings);
    if (target === 'chat') {
      settings.agent.defaultModel = DEFAULT_SETUP_MODEL_ALIAS;
    } else if (target === 'jobs') {
      settings.agent.oneTimeJobDefaultModel = '';
      settings.agent.recurringJobDefaultModel = '';
    } else if (target === 'memory') {
      applyProviderManagedMemoryDefaults(settings, memoryProviderId);
    }
    const writeResult = await persistSettings(previousSettings, settings);
    console.log(formatTarget(settings, target));
    if (target === 'memory') {
      noteRestartRequired(writeResult);
      await noteUnconfiguredMemoryProviders(runtimeHome, settings);
    }
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

  if (action === 'doctor') {
    const validationFailures = modelValidationFailures(settings);
    const preflightResults =
      validationFailures.length === 0
        ? await Promise.all(
            selectedModelProviders(settings).map(async (providerId) => ({
              providerId,
              result: await preflight(runtimeHome, providerId, settings),
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
        formatModelStatus(settings),
        validationFailures.length === 0
          ? 'model aliases: pass'
          : `model aliases: fail - ${validationFailures.join('; ')}`,
        `provider health: ${providerFromSettings(settings)}`,
        ...(preflightResults.length > 0
          ? preflightResults.map(({ providerId, result }) => {
              const label = providerLabel(providerId);
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

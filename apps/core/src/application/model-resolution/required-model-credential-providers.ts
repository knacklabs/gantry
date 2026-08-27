import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import {
  isModelFamilyAlias,
  resolveModelFamilyAlias,
} from '../../shared/model-families.js';

export type RequiredModelCredentialProvidersSettings = {
  agent: {
    defaultModel: string;
    oneTimeJobDefaultModel: string;
    recurringJobDefaultModel: string;
  };
  // Per-agent and per-binding model overrides also demand credentials; the
  // redacted Control API settings view may omit them.
  agents?: Record<
    string,
    | {
        model?: string;
        oneTimeJobDefaultModel?: string;
        recurringJobDefaultModel?: string;
      }
    | undefined
  >;
  bindings?: Record<string, { model?: string } | undefined>;
  modelFamilies?: Record<string, readonly string[]>;
  memory: {
    enabled: boolean;
    // Memory model/embedding detail is only present in the full runtime
    // settings. The redacted Control API settings view omits it; when absent we
    // can only require the chat/job model providers, not memory ones.
    embeddings?: { enabled: boolean; provider: string };
    dreaming?: {
      enabled?: boolean;
      embeddings?: { enabled: boolean; provider: string };
    };
    llm?: {
      models: {
        extractor: string;
        dreaming: string;
        consolidation: string;
      };
    };
  };
};

export type RequiredModelCredentialProviderUsage = {
  providerId: string;
  reason: string;
};

/**
 * Compute the set of model provider IDs that the configured chat/job/memory
 * model defaults require active credentials for. Pure function shared by the
 * CLI doctor readiness check and the control-plane read-model builders.
 */
export function requiredModelCredentialProviders(
  settings: RequiredModelCredentialProvidersSettings,
  options: { configuredProviderIds?: ReadonlySet<string> } = {},
): string[] {
  return [
    ...new Set(
      requiredModelCredentialProviderUsage(settings, options).map(
        (usage) => usage.providerId,
      ),
    ),
  ].sort();
}

/** Human-readable reasons for the effective runtime providers required by settings. */
export function requiredModelCredentialProviderUsage(
  settings: RequiredModelCredentialProvidersSettings,
  options: { configuredProviderIds?: ReadonlySet<string> } = {},
): RequiredModelCredentialProviderUsage[] {
  const slots: Array<{
    alias: string;
    workload: ModelWorkload;
    reason: string;
  }> = [];
  const usage: RequiredModelCredentialProviderUsage[] = [];
  const chatAlias = settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
  slots.push(
    { alias: chatAlias, workload: 'chat', reason: 'Default chat model' },
    {
      alias: settings.agent.oneTimeJobDefaultModel || chatAlias,
      workload: 'one_time_job',
      reason: 'One-time jobs',
    },
    {
      alias: settings.agent.recurringJobDefaultModel || chatAlias,
      workload: 'recurring_job',
      reason: 'Recurring jobs',
    },
  );
  for (const agent of Object.values(settings.agents ?? {})) {
    if (!agent) continue;
    if (agent.model)
      slots.push({
        alias: agent.model,
        workload: 'chat',
        reason: 'Agent model override',
      });
    if (agent.oneTimeJobDefaultModel) {
      slots.push({
        alias: agent.oneTimeJobDefaultModel,
        workload: 'one_time_job',
        reason: 'Agent one-time job override',
      });
    }
    if (agent.recurringJobDefaultModel) {
      slots.push({
        alias: agent.recurringJobDefaultModel,
        workload: 'recurring_job',
        reason: 'Agent recurring job override',
      });
    }
  }
  for (const binding of Object.values(settings.bindings ?? {})) {
    if (binding?.model)
      slots.push({
        alias: binding.model,
        workload: 'chat',
        reason: 'Conversation binding override',
      });
  }
  if (settings.memory.enabled && settings.memory.llm) {
    const memoryModels = settings.memory.llm.models;
    for (const [alias, workload, reason] of [
      [memoryModels.extractor, 'memory_extractor', 'Memory extraction'],
      [memoryModels.dreaming, 'memory_dreaming', 'Memory dreaming'],
      [
        memoryModels.consolidation,
        'memory_consolidation',
        'Memory consolidation',
      ],
    ] as const) {
      slots.push({ alias, workload, reason });
    }
    const embeddingProviders = [
      settings.memory.embeddings?.enabled
        ? settings.memory.embeddings.provider
        : 'disabled',
      settings.memory.dreaming?.embeddings?.enabled
        ? settings.memory.dreaming.embeddings.provider
        : 'disabled',
    ];
    for (const [providerId, reason] of embeddingProviders.map(
      (providerId, index) =>
        [
          providerId,
          index === 0 ? 'Memory embeddings' : 'Memory dreaming embeddings',
        ] as const,
    )) {
      if (providerId !== 'disabled') usage.push({ providerId, reason });
    }
  }
  for (const slot of slots) {
    // A family alias requires whichever member the runtime would select:
    // the first configured member, or the first member as the runtime's own
    // fallback — so an unconfigured family still surfaces a missing
    // credential instead of silently requiring nothing.
    const alias = isModelFamilyAlias(slot.alias)
      ? (resolveModelFamilyAlias(slot.alias, {
          isProviderConfigured: (providerId) =>
            options.configuredProviderIds?.has(providerId) ?? false,
          order: settings.modelFamilies,
        })?.alias ?? slot.alias)
      : slot.alias;
    const resolved = resolveModelSelectionForWorkload(alias, slot.workload);
    if (resolved.ok) {
      usage.push({
        providerId: resolved.entry.modelRoute.id,
        reason: slot.reason,
      });
    }
  }
  return usage.sort((left, right) =>
    `${left.providerId}:${left.reason}`.localeCompare(
      `${right.providerId}:${right.reason}`,
    ),
  );
}

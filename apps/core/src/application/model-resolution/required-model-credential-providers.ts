import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../../shared/model-catalog.js';

export type RequiredModelCredentialProvidersSettings = {
  agent: {
    defaultModel: string;
    oneTimeJobDefaultModel: string;
    recurringJobDefaultModel: string;
  };
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

/**
 * Compute the set of model provider IDs that the configured chat/job/memory
 * model defaults require active credentials for. Pure function shared by the
 * CLI doctor readiness check and the control-plane read-model builders.
 */
export function requiredModelCredentialProviders(
  settings: RequiredModelCredentialProvidersSettings,
): string[] {
  const slots: Array<{ alias: string; workload: ModelWorkload }> = [];
  const providers = new Set<string>();
  const chatAlias = settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
  slots.push(
    { alias: chatAlias, workload: 'chat' },
    {
      alias: settings.agent.oneTimeJobDefaultModel || chatAlias,
      workload: 'one_time_job',
    },
    {
      alias: settings.agent.recurringJobDefaultModel || chatAlias,
      workload: 'recurring_job',
    },
  );
  if (settings.memory.enabled && settings.memory.llm) {
    const memoryModels = settings.memory.llm.models;
    for (const [alias, workload] of [
      [memoryModels.extractor, 'memory_extractor'],
      [memoryModels.dreaming, 'memory_dreaming'],
      [memoryModels.consolidation, 'memory_consolidation'],
    ] as const) {
      slots.push({ alias, workload });
    }
    const embeddingProviders = [
      settings.memory.embeddings?.enabled
        ? settings.memory.embeddings.provider
        : 'disabled',
      settings.memory.dreaming?.embeddings?.enabled
        ? settings.memory.dreaming.embeddings.provider
        : 'disabled',
    ];
    for (const providerId of embeddingProviders) {
      if (providerId !== 'disabled') providers.add(providerId);
    }
  }
  for (const slot of slots) {
    const resolved = resolveModelSelectionForWorkload(
      slot.alias,
      slot.workload,
    );
    if (resolved.ok) providers.add(resolved.entry.modelRoute.id);
  }
  return [...providers].sort();
}

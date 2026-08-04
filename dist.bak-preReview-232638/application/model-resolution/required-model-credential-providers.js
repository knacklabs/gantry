import { DEFAULT_SETUP_MODEL_ALIAS, resolveModelSelectionForWorkload, } from '../../shared/model-catalog.js';
import { isModelFamilyAlias, resolveModelFamilyAlias, } from '../../shared/model-families.js';
/**
 * Compute the set of model provider IDs that the configured chat/job/memory
 * model defaults require active credentials for. Pure function shared by the
 * CLI doctor readiness check and the control-plane read-model builders.
 */
export function requiredModelCredentialProviders(settings, options = {}) {
    const slots = [];
    const providers = new Set();
    const chatAlias = settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
    slots.push({ alias: chatAlias, workload: 'chat' }, {
        alias: settings.agent.oneTimeJobDefaultModel || chatAlias,
        workload: 'one_time_job',
    }, {
        alias: settings.agent.recurringJobDefaultModel || chatAlias,
        workload: 'recurring_job',
    });
    for (const agent of Object.values(settings.agents ?? {})) {
        if (!agent)
            continue;
        if (agent.model)
            slots.push({ alias: agent.model, workload: 'chat' });
        if (agent.oneTimeJobDefaultModel) {
            slots.push({
                alias: agent.oneTimeJobDefaultModel,
                workload: 'one_time_job',
            });
        }
        if (agent.recurringJobDefaultModel) {
            slots.push({
                alias: agent.recurringJobDefaultModel,
                workload: 'recurring_job',
            });
        }
    }
    for (const binding of Object.values(settings.bindings ?? {})) {
        if (binding?.model)
            slots.push({ alias: binding.model, workload: 'chat' });
    }
    if (settings.memory.enabled && settings.memory.llm) {
        const memoryModels = settings.memory.llm.models;
        for (const [alias, workload] of [
            [memoryModels.extractor, 'memory_extractor'],
            [memoryModels.dreaming, 'memory_dreaming'],
            [memoryModels.consolidation, 'memory_consolidation'],
        ]) {
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
            if (providerId !== 'disabled')
                providers.add(providerId);
        }
    }
    for (const slot of slots) {
        // A family alias requires whichever member the runtime would select:
        // the first configured member, or the first member as the runtime's own
        // fallback — so an unconfigured family still surfaces a missing
        // credential instead of silently requiring nothing.
        const alias = isModelFamilyAlias(slot.alias)
            ? (resolveModelFamilyAlias(slot.alias, {
                isProviderConfigured: (providerId) => options.configuredProviderIds?.has(providerId) ?? false,
                order: settings.modelFamilies,
            })?.alias ?? slot.alias)
            : slot.alias;
        const resolved = resolveModelSelectionForWorkload(alias, slot.workload);
        if (resolved.ok)
            providers.add(resolved.entry.modelRoute.id);
    }
    return [...providers].sort();
}

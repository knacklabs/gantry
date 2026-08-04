import { logger } from '../infrastructure/logging/logger.js';
import { isModelFamilyAlias, resolveModelFamilyAlias, resolveModelFamilyCandidates, } from '../shared/model-families.js';
// Resolve a possibly-family model alias to a concrete catalog alias using this
// app's configured providers. Non-family aliases pass through unchanged (the
// lookup is never called). On any lookup failure the original alias is returned
// (resolution then proceeds and fails loudly downstream) so a transient
// credential read never blocks a run.
export async function rewriteModelFamilyAliasForApp(input) {
    const { alias, appId, listConfiguredProviders, familyOrder } = input;
    if (!isModelFamilyAlias(alias))
        return alias;
    let configured;
    try {
        configured = await listConfiguredProviders(appId);
    }
    catch (err) {
        logger.warn({ err, alias, appId }, 'Failed to read configured model providers for family resolution; using family alias unchanged');
        return alias;
    }
    const resolved = resolveModelFamilyAlias(alias, {
        isProviderConfigured: (providerId) => configured.has(providerId),
        order: familyOrder,
    });
    return resolved ? resolved.alias : alias;
}
// Ordered failover candidate list for a possibly-family alias, paralleling
// `rewriteModelFamilyAliasForApp` but returning EVERY candidate (configured
// first, unconfigured last) instead of just the first. The single-rewrite path
// equals `candidates[0]`. Non-family aliases return `[alias]` (the lookup is
// never called). On any lookup failure the alias is returned unchanged as the
// sole candidate so a transient credential read never blocks a run, and the
// downstream spawn still fails loudly if that provider is unset.
export async function resolveModelFamilyCandidatesForApp(input) {
    const { alias, appId, listConfiguredProviders, familyOrder } = input;
    if (!isModelFamilyAlias(alias))
        return [alias];
    let configured;
    try {
        configured = await listConfiguredProviders(appId);
    }
    catch (err) {
        logger.warn({ err, alias, appId }, 'Failed to read configured model providers for family failover; using family alias unchanged');
        return [alias];
    }
    const candidates = resolveModelFamilyCandidates(alias, {
        isProviderConfigured: (providerId) => configured.has(providerId),
        order: familyOrder,
    });
    return candidates.length > 0 ? candidates : [alias];
}

export function validateModelProviderMetadata(entry) {
    validateModelProviderAvailability(entry);
    validateModelProviderRouting(entry);
}
function validateModelProviderAvailability(entry) {
    const availability = entry.providerAvailability;
    if (!availability)
        return;
    if (!availability.verifiedAt.trim()) {
        throw new Error(`Model catalog entry ${entry.id} has empty providerAvailability.verifiedAt.`);
    }
    if (!availability.evidence.commandOrUrl.trim()) {
        throw new Error(`Model catalog entry ${entry.id} has empty providerAvailability evidence.`);
    }
    if (availability.scope.kind !== 'provider' &&
        availability.scope.values.some((value) => !value.trim())) {
        throw new Error(`Model catalog entry ${entry.id} has empty providerAvailability scope value.`);
    }
}
function validateModelProviderRouting(entry) {
    const routing = entry.providerRouting?.openrouter;
    if (!routing)
        return;
    if (entry.modelRoute.id !== 'openrouter') {
        throw new Error(`Model catalog entry ${entry.id} declares OpenRouter provider routing on route ${entry.modelRoute.id}.`);
    }
    const stringLists = [
        ['only', routing.only],
        ['ignore', routing.ignore],
        ['order', routing.order],
        ['quantizations', routing.quantizations],
    ];
    for (const [field, values] of stringLists) {
        if (values?.some((value) => !value.trim())) {
            throw new Error(`Model catalog entry ${entry.id} has empty OpenRouter provider.${field} value.`);
        }
    }
    const only = new Set(routing.only?.map((value) => value.toLowerCase()));
    const overlap = routing.ignore?.find((value) => only.has(value.toLowerCase()));
    if (overlap) {
        throw new Error(`Model catalog entry ${entry.id} lists OpenRouter provider ${overlap} in both only and ignore.`);
    }
}

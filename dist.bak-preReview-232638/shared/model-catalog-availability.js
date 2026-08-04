import { getModelProviderDefinition } from './model-provider-registry.js';
import { describeFamilyResolution, } from './model-families.js';
// Credential-aware availability badges for the model catalog and CLI surfaces.
// A `configuredProviders` set (route/provider ids with an ACTIVE Model Access
// credential for the current app) drives "available now" vs "needs <provider>
// key". When the set is undefined the surface degrades to NO badges (current
// behavior) — never a crash. This module is pure: the configured set + the
// optional family order override are injected by the caller.
export function providerLabel(providerId) {
    if (!providerId)
        return 'unknown provider';
    return getModelProviderDefinition(providerId)?.label ?? providerId;
}
// Badge for a concrete catalog row. Returns undefined (no badge) when the
// configured set is unavailable, or 'available' / 'needs <provider> key'.
export function availabilityBadgeForProvider(providerId, configuredProviders) {
    if (!configuredProviders)
        return undefined;
    if (configuredProviders.has(providerId))
        return 'available';
    return `needs ${providerLabel(providerId)} key`;
}
// Resolve how a family would select a provider for the configured set. Shared by
// the /models family rows and `/model why <family>`.
export function describeFamilyAvailability(family, configuredProviders, order) {
    return describeFamilyResolution(family, {
        isProviderConfigured: (providerId) => configuredProviders?.has(providerId) ?? false,
        order,
        providerLabel,
    });
}
// One-line family availability badge for a /models family row. Undefined when
// the configured set is unavailable (no badge). When at least one member is
// configured: `available via <provider>`. Otherwise: `needs a key for one of:
// <provider>, <provider>`.
export function familyAvailabilityBadge(description, configuredProviders) {
    if (!configuredProviders)
        return undefined;
    if (description.selectedConfigured) {
        return `available via ${description.selectedProviderLabel}`;
    }
    const providers = [
        ...new Set(description.members.map((entry) => entry.providerLabel)),
    ];
    return `needs a key for one of: ${providers.join(', ')}`;
}

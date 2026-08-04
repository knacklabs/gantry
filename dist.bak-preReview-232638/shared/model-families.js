import { resolveModelSelection, resolveModelSelectionForWorkload, } from './model-catalog.js';
// Seed exactly the real overlaps in the current catalog. Keep this trivial to
// extend as more overlapping providers are added.
export const MODEL_FAMILIES = [
    {
        alias: 'gpt-oss',
        displayName: 'GPT-OSS 120B',
        members: ['groq-oss', 'cerebras'],
    },
    {
        alias: 'llama-70b',
        displayName: 'Llama 3.3 70B',
        members: ['groq', 'together'],
    },
];
function normalizeFamilyKey(value) {
    return value
        .normalize('NFKC')
        .trim()
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
}
// Built at load: this also runs the collision/membership guards below (mirrors
// the catalog's buildAliasIndex), throwing if any family alias collides with a
// concrete catalog alias or references an unknown member.
const FAMILY_INDEX = buildFamilyIndex();
function buildFamilyIndex() {
    const families = new Map();
    for (const family of MODEL_FAMILIES) {
        const key = normalizeFamilyKey(family.alias);
        if (families.has(key)) {
            throw new Error(`Duplicate model family alias: ${family.alias}`);
        }
        // A family alias MUST NOT collide with any concrete catalog alias: the two
        // namespaces are separate and resolution depends on that separation.
        const catalogCollision = resolveModelSelection(family.alias);
        if (catalogCollision.ok) {
            throw new Error(`Model family alias ${family.alias} collides with catalog alias ${catalogCollision.alias}.`);
        }
        // Every member must be a real concrete catalog alias.
        for (const member of family.members) {
            const resolved = resolveModelSelection(member);
            if (!resolved.ok) {
                throw new Error(`Model family ${family.alias} references unknown member alias ${member}.`);
            }
        }
        families.set(key, family);
    }
    return families;
}
export function listModelFamilies() {
    return MODEL_FAMILIES;
}
export const CHEAPEST_ORDER_TOKEN = 'cheapest';
// Total token price (input + output USD per 1M) for a family member, or
// undefined when the member's catalog entry declares no pricing. Used as the
// cost-ordering key.
function familyMemberTotalPriceUsd(member) {
    const resolved = resolveModelSelection(member);
    if (!resolved.ok)
        return undefined;
    const { inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output } = resolved.entry;
    if (typeof input !== 'number' || typeof output !== 'number')
        return undefined;
    return input + output;
}
// Effective member order for a family given an optional override. Pure: tokens
// are matched against the family's own members (by alias or by the member's
// provider id), de-duplicated in override order, then any remaining default
// members are appended. The `cheapest` token cost-orders the remainder. Returns
// the hardcoded order when no override applies.
export function effectiveFamilyMembers(family, order) {
    const override = order?.[family.alias] ?? order?.[normalizeFamilyKey(family.alias)];
    if (!override || override.length === 0)
        return family.members;
    const cheapest = override.some((token) => normalizeFamilyKey(token) === CHEAPEST_ORDER_TOKEN);
    const memberByToken = new Map();
    for (const member of family.members) {
        memberByToken.set(normalizeFamilyKey(member), member);
        const providerId = providerIdForFamilyMember(member);
        if (providerId)
            memberByToken.set(normalizeFamilyKey(providerId), member);
    }
    const ordered = [];
    const seen = new Set();
    for (const token of override) {
        const member = memberByToken.get(normalizeFamilyKey(token));
        if (member && !seen.has(member)) {
            ordered.push(member);
            seen.add(member);
        }
    }
    const remaining = family.members.filter((member) => !seen.has(member));
    if (cheapest) {
        // Stable sort by total price ascending; unpriced members keep declared order
        // at the end (Infinity key).
        remaining.sort((a, b) => (familyMemberTotalPriceUsd(a) ?? Number.POSITIVE_INFINITY) -
            (familyMemberTotalPriceUsd(b) ?? Number.POSITIVE_INFINITY));
    }
    ordered.push(...remaining);
    return ordered;
}
export function isModelFamilyAlias(value) {
    if (!value)
        return false;
    return FAMILY_INDEX.has(normalizeFamilyKey(value));
}
export function getModelFamily(value) {
    if (!value)
        return undefined;
    return FAMILY_INDEX.get(normalizeFamilyKey(value));
}
// Map a member alias to its provider id via the catalog
// (resolveModelSelection(member).entry.modelRoute.id).
export function providerIdForFamilyMember(member) {
    const resolved = resolveModelSelection(member);
    return resolved.ok ? resolved.entry.modelRoute.id : undefined;
}
// Resolve a family alias to a concrete member alias.
//   - If `alias` is NOT a family alias -> null (caller uses the alias unchanged).
//   - Otherwise -> the first member whose provider satisfies
//     `isProviderConfigured`. If none configured -> the FIRST member, so
//     resolution proceeds and the broker fails loudly with that provider's
//     setup message.
// Pure/sync: the `isProviderConfigured` predicate is injected.
export function resolveModelFamilyAlias(alias, deps) {
    const family = getModelFamily(alias);
    if (!family)
        return null;
    const members = effectiveFamilyMembers(family, deps.order);
    for (const member of members) {
        const providerId = providerIdForFamilyMember(member);
        if (providerId && deps.isProviderConfigured(providerId)) {
            return { alias: member };
        }
    }
    return { alias: members[0] };
}
// Ordered failover candidate list for a model alias. For a NON-family alias the
// caller uses it unchanged, so candidates = [alias]. For a family alias the
// candidates are its concrete members in effective order, partitioned so every
// CONFIGURED member comes first (in effective order) and every UNCONFIGURED
// member is appended last as a last-resort attempt. This is the runtime-failover
// generalization of `resolveModelFamilyAlias`, whose single result is exactly
// `resolveModelFamilyCandidates(alias, deps)[0]`. Pure/sync: the
// `isProviderConfigured` predicate is injected, mirroring the single-rewrite
// path.
export function resolveModelFamilyCandidates(alias, deps) {
    const family = getModelFamily(alias);
    if (!family)
        return alias ? [alias] : [];
    const members = effectiveFamilyMembers(family, deps.order);
    const configured = [];
    const unconfigured = [];
    for (const member of members) {
        const providerId = providerIdForFamilyMember(member);
        if (providerId && deps.isProviderConfigured(providerId)) {
            configured.push(member);
        }
        else {
            unconfigured.push(member);
        }
    }
    // Configured-first, then unconfigured last as last-resort. When none are
    // configured this is just the effective member order (first member leads),
    // matching the loud-failure fallback of resolveModelFamilyAlias.
    return [...configured, ...unconfigured];
}
// Describe how a family alias resolves for the current configured-provider set,
// honoring the optional order override. Used by /models badges and /model why.
// Pure: configured membership + the order map are injected. `providerLabel` for
// each member is resolved via the catalog (member -> provider label).
export function describeFamilyResolution(family, deps) {
    const ordered = effectiveFamilyMembers(family, deps.order);
    const members = ordered.map((member) => {
        const providerId = providerIdForFamilyMember(member);
        return {
            member,
            providerId,
            providerLabel: deps.providerLabel(providerId),
            configured: providerId ? deps.isProviderConfigured(providerId) : false,
        };
    });
    const firstConfigured = members.find((entry) => entry.configured);
    const selected = firstConfigured ?? members[0];
    return {
        family,
        members,
        selectedMember: selected.member,
        selectedProviderId: selected.providerId,
        selectedProviderLabel: selected.providerLabel,
        selectedConfigured: Boolean(firstConfigured),
    };
}
// Family-aware workload resolution for the user-selection seam (/model set).
// A concrete alias resolves through the catalog unchanged. A family alias is
// accepted iff EVERY member supports the workload (all members are chat models
// today); the returned resolution carries the FAMILY alias (so /model gpt-oss
// stores gpt-oss) but borrows the first member's concrete entry/runnerModel for
// display. The credential-driven provider is picked later at spawn.
export function resolveModelSelectionForWorkloadWithFamilies(value, workload, order) {
    const family = getModelFamily(value);
    if (!family) {
        return resolveModelSelectionForWorkload(value, workload);
    }
    const members = effectiveFamilyMembers(family, order);
    const unsupported = members.find((member) => {
        const resolved = resolveModelSelectionForWorkload(member, workload);
        return !resolved.ok;
    });
    if (unsupported) {
        return {
            ok: false,
            input: family.alias,
            reason: 'unsupported-workload',
            message: `Model family "${family.alias}" is not eligible for this workload. Use /models to view supported workloads.`,
        };
    }
    const firstMember = resolveModelSelectionForWorkload(members[0], workload);
    if (!firstMember.ok)
        return firstMember;
    return {
        ok: true,
        alias: family.alias,
        entry: firstMember.entry,
        runnerModel: firstMember.runnerModel,
    };
}

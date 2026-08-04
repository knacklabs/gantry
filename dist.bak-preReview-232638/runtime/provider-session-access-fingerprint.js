import { createHash } from 'node:crypto';
export function buildProviderSessionAccessFingerprint(input) {
    const payload = {
        version: 2,
        accessPreset: input.accessPreset,
        toolPolicyRules: sortedUnique(input.toolPolicyRules),
        attachedSkillSourceIds: sortedUnique(input.attachedSkillSourceIds),
        attachedMcpSourceIds: sortedUnique(input.attachedMcpSourceIds),
        runtimeAccess: normalizeRuntimeAccess(input.runtimeAccess),
        semanticCapabilities: normalizeSemanticCapabilities(input.semanticCapabilities),
        capabilityCatalogDigest: input.capabilityCatalogDigest?.trim() || null,
    };
    return `provider-session-access:v2:${createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex')}`;
}
export function providerSessionAccessFingerprintMatches(stored, current) {
    return stored === current;
}
function sortedUnique(values) {
    return [
        ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
    ].sort((left, right) => left.localeCompare(right));
}
function normalizeRuntimeAccess(values) {
    return (values ?? [])
        .map((access) => ({
        sourceType: access.sourceType,
        selectedCapabilityId: access.selectedCapabilityId,
        auditLabel: access.auditLabel,
        ...('adapterRef' in access ? { adapterRef: access.adapterRef } : {}),
        ...('skillId' in access ? { skillId: access.skillId } : {}),
        ...('selectedAction' in access
            ? { selectedAction: access.selectedAction }
            : {}),
        ...('reviewedServerId' in access
            ? { reviewedServerId: access.reviewedServerId }
            : {}),
        ...('allowedTools' in access
            ? { allowedTools: sortedUnique(access.allowedTools) }
            : {}),
        ...('commandRules' in access
            ? { commandRules: sortedUnique(access.commandRules) }
            : {}),
        ...('runtimeToolRules' in access
            ? { runtimeToolRules: sortedUnique(access.runtimeToolRules) }
            : {}),
        ...('networkHosts' in access
            ? { networkHosts: sortedUnique(access.networkHosts) }
            : {}),
    }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function normalizeSemanticCapabilities(values) {
    return (values ?? [])
        .map((capability) => ({
        capabilityId: capability.capabilityId,
        version: capability.version,
        source: capability.source ?? null,
    }))
        .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

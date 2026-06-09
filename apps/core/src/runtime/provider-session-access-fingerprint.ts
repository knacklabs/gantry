import { createHash } from 'node:crypto';

import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';

export interface ProviderSessionAccessFingerprintInput {
  toolPolicyRules?: readonly string[];
  runtimeAccess?: readonly CapabilityRuntimeAccess[];
  attachedSkillSourceIds?: readonly string[];
  attachedMcpSourceIds?: readonly string[];
  semanticCapabilities?: readonly SemanticCapabilityDefinition[];
}

export function buildProviderSessionAccessFingerprint(
  input: ProviderSessionAccessFingerprintInput,
): string {
  const payload = {
    version: 1,
    toolPolicyRules: sortedUnique(input.toolPolicyRules),
    attachedSkillSourceIds: sortedUnique(input.attachedSkillSourceIds),
    attachedMcpSourceIds: sortedUnique(input.attachedMcpSourceIds),
    runtimeAccess: normalizeRuntimeAccess(input.runtimeAccess),
    semanticCapabilities: normalizeSemanticCapabilities(
      input.semanticCapabilities,
    ),
  };
  return `provider-session-access:v1:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`;
}

export function providerSessionAccessFingerprintMatches(
  stored: string | null | undefined,
  current: string,
): boolean {
  return stored === current;
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeRuntimeAccess(
  values: readonly CapabilityRuntimeAccess[] | undefined,
) {
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
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function normalizeSemanticCapabilities(
  values: readonly SemanticCapabilityDefinition[] | undefined,
) {
  return (values ?? [])
    .map((capability) => ({
      capabilityId: capability.capabilityId,
      version: capability.version,
      source: capability.source ?? null,
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

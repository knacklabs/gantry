import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
export interface ProviderSessionAccessFingerprintInput {
    accessPreset: 'full' | 'locked';
    toolPolicyRules?: readonly string[];
    runtimeAccess?: readonly CapabilityRuntimeAccess[];
    attachedSkillSourceIds?: readonly string[];
    attachedMcpSourceIds?: readonly string[];
    semanticCapabilities?: readonly SemanticCapabilityDefinition[];
    capabilityCatalogDigest?: string;
}
export declare function buildProviderSessionAccessFingerprint(input: ProviderSessionAccessFingerprintInput): string;
export declare function providerSessionAccessFingerprintMatches(stored: string | null | undefined, current: string): boolean;

import type { LlmProfile } from '../../domain/agent/agent.js';
import { type ModelCapabilityDescriptor, type ModelCatalogEntry, type ModelExecutionProviderId, type ModelResponseFamily, type ModelRouteId, type ModelWorkload } from '../../shared/model-catalog.js';
import type { AgentEngine, AgentHarness } from '../../shared/agent-engine.js';
export interface ResolvedLlmProfile {
    profile: LlmProfile;
    alias: string;
    modelEntry: ModelCatalogEntry;
    runnerModel: string;
    responseFamily: ModelResponseFamily;
    modelRoute: {
        id: ModelRouteId;
        label: string;
        metadata: {
            providerModelId: string;
        };
    };
    executionProviderId: ModelExecutionProviderId;
    agentEngine: AgentEngine;
    supportedCredentialModes: readonly string[];
    credentialProfileRef: string;
    capabilities: ModelCapabilityDescriptor;
}
export type LlmProfileResolution = {
    ok: true;
    value: ResolvedLlmProfile;
} | {
    ok: false;
    reason: 'empty' | 'unknown' | 'raw-provider-id' | 'unsupported-workload' | 'unknown-provider' | 'incompatible-harness';
    message: string;
};
export declare class LlmProfileResolutionService {
    resolve(input: {
        profile: LlmProfile;
        workload: ModelWorkload;
        agentHarness?: AgentHarness;
    }): LlmProfileResolution;
}

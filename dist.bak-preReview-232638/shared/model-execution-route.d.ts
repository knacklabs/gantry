import type { AgentEngine, AgentHarness } from './agent-engine.js';
import type { ModelCatalogEntry, ModelExecutionProviderId } from './model-catalog.js';
import { type ModelExecutionRoute } from './model-provider-registry.js';
export interface ResolvedExecutionRoute {
    route: ModelExecutionRoute;
    engine: AgentEngine;
    executionProviderId: ModelExecutionRoute['executionProviderId'];
    supportedCredentialModes: readonly string[];
}
export type ExecutionRouteResolution = {
    ok: true;
    value: ResolvedExecutionRoute;
} | {
    ok: false;
    reason: 'unknown-provider' | 'incompatible-harness';
    message: string;
};
export declare function resolveExecutionRoute(input: {
    entry: ModelCatalogEntry;
    agentHarness?: AgentHarness;
}): ExecutionRouteResolution;
export declare function executionRoutesForEntry(entry: ModelCatalogEntry): {
    harness: AgentEngine;
    executionProviderId: ModelExecutionProviderId;
}[];
export type MemoryTransportLane = 'native_sdk' | 'openai_direct';
export declare function memoryTransportLaneForModel(input: {
    providerId?: string | null;
    responseFamily: string | null | undefined;
}): MemoryTransportLane | null;
export declare function deriveAgentEngineForProvider(providerId: string): AgentEngine;
export declare function engineForExecutionProviderId(executionProviderId: string): AgentEngine | undefined;

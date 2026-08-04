import { AUTO_AGENT_HARNESS, DEFAULT_AGENT_ENGINE, DEEPAGENTS_ENGINE, } from './agent-engine.js';
import { getModelProviderDefinition, listModelRouteProviders, } from './model-provider-registry.js';
// Resolves `modelAlias -> executionRoute`. The engine is no longer chosen: it is
// derived from the resolved entry's provider, which carries the single execution
// route (engine + execution adapter + supported credential modes). Credential-mode
// rejection happens later, where the bound credential mode is known, using
// `supportedCredentialModes`.
export function resolveExecutionRoute(input) {
    const { entry } = input;
    const provider = getModelProviderDefinition(entry.modelRoute.id);
    if (!provider) {
        return {
            ok: false,
            reason: 'unknown-provider',
            message: `Model ${entry.recommendedAlias} references unsupported provider route ${entry.modelRoute.id}.`,
        };
    }
    const route = provider.executionRoute;
    const agentHarness = input.agentHarness ?? AUTO_AGENT_HARNESS;
    if (agentHarness !== AUTO_AGENT_HARNESS && agentHarness !== route.engine) {
        return {
            ok: false,
            reason: 'incompatible-harness',
            message: `Model ${entry.recommendedAlias} cannot run with agent harness ${agentHarness}.`,
        };
    }
    return {
        ok: true,
        value: {
            route,
            engine: route.engine,
            executionProviderId: route.executionProviderId,
            supportedCredentialModes: route.supportedCredentialModes,
        },
    };
}
// Read-only diagnostic for model-catalog response shapes: the derived single
// route as a one-element array (engine + executionProviderId). Returns an empty
// array for an unknown provider so the response field stays well-formed.
export function executionRoutesForEntry(entry) {
    const provider = getModelProviderDefinition(entry.modelRoute.id);
    if (!provider)
        return [];
    return [
        {
            harness: provider.executionRoute.engine,
            executionProviderId: provider.executionRoute.executionProviderId,
        },
    ];
}
const DEFAULT_MEMORY_RESPONSE_FAMILY = 'anthropic';
const SECONDARY_MEMORY_RESPONSE_FAMILY = 'openai';
export function memoryTransportLaneForModel(input) {
    if (input.providerId) {
        const provider = getModelProviderDefinition(input.providerId);
        if (provider &&
            provider.executionRoute.engine === DEEPAGENTS_ENGINE &&
            provider.responseFamily !== SECONDARY_MEMORY_RESPONSE_FAMILY) {
            return 'openai_direct';
        }
    }
    if (input.responseFamily === SECONDARY_MEMORY_RESPONSE_FAMILY) {
        return 'openai_direct';
    }
    if (input.responseFamily === DEFAULT_MEMORY_RESPONSE_FAMILY) {
        return 'native_sdk';
    }
    return null;
}
// The single provider -> engine derivation point. The engine is read-only:
// callers pass the resolved model's provider id and get the engine its models
// run on. Unknown providers fall back to the system default.
export function deriveAgentEngineForProvider(providerId) {
    const provider = getModelProviderDefinition(providerId);
    return provider?.executionRoute.engine ?? DEFAULT_AGENT_ENGINE;
}
// Reverse lookup: which agent engine an internal `executionProviderId` belongs
// to. The execution-route registry maps each provider to its single
// `executionProviderId`; this inverts it so run diagnostics (job run detail,
// run-start audit) can surface the derived engine from the persisted diagnostic
// provider id. Returns undefined for an unknown provider id.
export function engineForExecutionProviderId(executionProviderId) {
    const normalized = executionProviderId.trim();
    for (const provider of listModelRouteProviders()) {
        if (provider.executionRoute.executionProviderId === normalized) {
            return provider.executionRoute.engine;
        }
    }
    return undefined;
}

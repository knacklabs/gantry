// Internal agent-engine vocabulary. This module is the single source of the SDK
// engine value outside the provider adapter and the contracts zod enum; every
// other module references the exported constants so the provider-boundary
// architecture gate stays count-exact. The SDK engine is the Claude
// OAuth/subscription + API-key lane; DeepAgents is the API-key engine for every
// other provider. The engine is no longer user-selectable: it is derived from
// the resolved model's provider (see `deriveAgentEngineForProvider` in
// model-execution-route.ts) and surfaced only as a read-only diagnostic.
export const DEEPAGENTS_ENGINE = 'deepagents';
// The literal lives here exactly once. `DEFAULT_AGENT_ENGINE` is the only
// exported handle to it, so consumers never restate the provider literal.
export const DEFAULT_AGENT_ENGINE = 'anthropic_sdk';
export const AGENT_ENGINES = [DEFAULT_AGENT_ENGINE, DEEPAGENTS_ENGINE];
export const AUTO_AGENT_HARNESS = 'auto';
export const AGENT_HARNESSES = [
    AUTO_AGENT_HARNESS,
    DEFAULT_AGENT_ENGINE,
    DEEPAGENTS_ENGINE,
];
const AGENT_ENGINE_LABELS = {
    [DEFAULT_AGENT_ENGINE]: 'Anthropic SDK',
    [DEEPAGENTS_ENGINE]: 'DeepAgents',
};
export function agentEngineLabel(engine) {
    return AGENT_ENGINE_LABELS[engine];
}
export function isAgentEngine(value) {
    return (typeof value === 'string' &&
        AGENT_ENGINES.includes(value));
}
export function isAgentHarness(value) {
    return (typeof value === 'string' &&
        AGENT_HARNESSES.includes(value));
}

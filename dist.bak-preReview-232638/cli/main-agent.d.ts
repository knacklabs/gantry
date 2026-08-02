export { defaultTriggerForAgentName } from '../shared/trigger-pattern.js';
export declare const DEFAULT_AGENT_CLI_NAME = "Default Agent";
export declare const DEFAULT_AGENT_FOLDER = "main_agent";
/**
 * True when `folder` is the default agent and the given routes contain only one
 * route for it. The runtime re-seeds a default agent route whenever no routes
 * remain (ensureFreshRuntimeHasDefaultAgent), so removing the default agent's
 * last route can silently return on the next boot -- callers should refuse it.
 */
export declare function isDefaultAgentLastRoute(groups: Record<string, {
    folder: string;
}>, folder: string): boolean;
export declare function normalizeDefaultAgentName(raw: string | undefined): string;
export declare function defaultAgentNameFromSettings(settings: {
    agent: {
        name?: string;
    };
}): string;
export declare function allocateDefaultAgentFolder(runtimeHome: string, existing: Record<string, {
    folder: string;
}>): string;
export declare function displayAgentName(group: {
    name: string;
}, configuredDefaultAgentName?: string): string;

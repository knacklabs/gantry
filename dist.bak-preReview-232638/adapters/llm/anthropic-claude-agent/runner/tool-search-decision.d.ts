import type { AgentRunnerInput, AgentRunnerRuntimeEventOutput } from './types.js';
export type ClaudeSdkToolSearchMode = 'auto:10' | 'false';
export interface ClaudeSdkToolSearchDecision {
    enableToolSearch: ClaudeSdkToolSearchMode;
    reason: 'official_auto_threshold' | 'gantry_gateway_tool_reference_pass_through' | 'non_first_party_base_url_tool_reference_unproven' | 'invalid_base_url_tool_reference_unproven' | 'no_registered_tools';
    availableToolCount: number;
    allowedToolCount: number;
    disallowedToolCount: number;
    mcpServerCount: number;
    serializedToolConfigBytes: number;
    anthropicBaseUrlKind: 'unset' | 'first_party' | 'gantry_loopback' | 'non_first_party' | 'invalid';
}
export declare function decideClaudeSdkToolSearch(input: {
    sdkEnv: Record<string, string | undefined>;
    availableTools: readonly string[];
    allowedTools: readonly string[];
    disallowedTools: readonly string[];
    mcpServers: Record<string, unknown>;
}): ClaudeSdkToolSearchDecision;
export declare function toolSearchStartupRuntimeEvent(input: {
    agentInput: AgentRunnerInput;
    decision: ClaudeSdkToolSearchDecision;
}): AgentRunnerRuntimeEventOutput;

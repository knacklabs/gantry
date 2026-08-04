export declare const SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION = "1.10.2";
export declare const DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE = "Async delegation is unavailable for this DeepAgents version. Gantry did not start delegated work.";
export declare const EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS: {
    readonly start_async_task: readonly ["agentName", "description"];
    readonly check_async_task: readonly ["taskId"];
    readonly update_async_task: readonly ["message", "taskId"];
    readonly cancel_async_task: readonly ["taskId"];
    readonly list_async_tasks: readonly ["statusFilter"];
};
export declare const EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES: Array<keyof typeof EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS>;
export type DeepAgentsAsyncSubagentSentinelReason = 'unsupported_package_version' | 'missing_exports' | 'async_discriminant_drift' | 'middleware_probe_failed' | 'tool_surface_drift' | 'tool_schema_drift' | 'gantry_transport_unavailable';
export type DeepAgentsAsyncSubagentSentinelResult = {
    ok: true;
    packageVersion: string;
    toolNames: string[];
    apiCompatible: true;
} | {
    ok: false;
    reason: DeepAgentsAsyncSubagentSentinelReason;
    message: string;
    packageVersion?: string;
    toolNames?: string[];
    apiCompatible?: boolean;
};
interface DeepAgentsAsyncSubagentSentinelInput {
    packageVersion: string;
    deepagentsModule: Record<string, unknown>;
    gantryAgentProtocolTransportReady?: boolean;
}
export declare function evaluateDeepAgentsAsyncSubagentSentinel(input: DeepAgentsAsyncSubagentSentinelInput): DeepAgentsAsyncSubagentSentinelResult;
export {};

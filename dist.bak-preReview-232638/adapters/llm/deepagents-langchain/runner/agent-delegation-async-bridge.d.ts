import { DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE } from './async-subagent-sentinel.js';
export interface AgentDelegationAsyncIntent {
    toolName: 'AgentDelegation';
    task: string;
}
export interface AgentDelegationAsyncBridgeInput {
    intent: AgentDelegationAsyncIntent;
    packageVersion: string;
    providerModule: Record<string, unknown>;
    asyncTaskToolsEnabled: boolean;
    sandboxReady: boolean;
    agentDelegationAuthorized: boolean;
    transportReady: boolean;
}
export type AgentDelegationAsyncBridgeUnavailableReason = 'async_task_tools_disabled' | 'sandbox_unavailable' | 'agent_delegation_unauthorized' | 'transport_unavailable' | 'provider_async_bridge_unavailable';
export type AgentDelegationAsyncBridgeResult = {
    status: 'ready';
    intent: AgentDelegationAsyncIntent;
    packageVersion: string;
    apiCompatible: true;
} | {
    status: 'unavailable';
    reason: AgentDelegationAsyncBridgeUnavailableReason;
    message: typeof DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE;
};
export declare function evaluateAgentDelegationAsyncBridge(input: AgentDelegationAsyncBridgeInput): AgentDelegationAsyncBridgeResult;

import type { AgentExecutionAdapter, AgentExecutionProviderId } from './agent-execution-adapter.js';
export interface AgentExecutionAdapterRegistry {
    get(id: string): AgentExecutionAdapter | undefined;
    has(id: string): boolean;
    list(): readonly AgentExecutionAdapter[];
}
export declare function createAgentExecutionAdapterRegistry(adapters: readonly AgentExecutionAdapter[]): AgentExecutionAdapterRegistry;
export declare function resolveAgentExecutionAdapter(input: {
    executionProviderId?: string;
    registry?: AgentExecutionAdapterRegistry;
    fallback?: AgentExecutionAdapter;
}): AgentExecutionAdapter | undefined;
export declare function executionProviderIdForAdapter(adapter: Pick<AgentExecutionAdapter, 'id'>): AgentExecutionProviderId;

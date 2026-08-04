import type { AgentExecutionAdapter, AgentExecutionAdapterPrepareInput, AgentExecutionProviderId, PreparedAgentExecution } from '../../../application/agent-execution/agent-execution-adapter.js';
export declare function deepAgentsCheckpointSchema(storageSchema: string): string;
export declare class DeepAgentsLangChainExecutionAdapter implements AgentExecutionAdapter {
    readonly id: AgentExecutionProviderId;
    isMissingProviderSessionError(error: string | undefined): boolean;
    prepare(input: AgentExecutionAdapterPrepareInput): Promise<PreparedAgentExecution>;
}
export declare function createDeepAgentsLangChainExecutionAdapter(): AgentExecutionAdapter;

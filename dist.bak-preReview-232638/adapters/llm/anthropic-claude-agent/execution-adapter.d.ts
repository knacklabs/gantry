import type { AgentExecutionAdapter, AgentExecutionAdapterPrepareInput, AgentExecutionProviderId, PreparedAgentExecution } from '../../../application/agent-execution/agent-execution-adapter.js';
export declare class AnthropicClaudeAgentExecutionAdapter implements AgentExecutionAdapter {
    readonly id: AgentExecutionProviderId;
    isMissingProviderSessionError(error: string | undefined): boolean;
    sessionCompactionPrompt(): string;
    prepare(input: AgentExecutionAdapterPrepareInput): Promise<PreparedAgentExecution>;
    private skillSources;
    private selectedSkillIds;
    private validateCredentialProjection;
}
export declare function createAnthropicClaudeAgentExecutionAdapter(): AgentExecutionAdapter;

import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import type { RunnerSandboxProvider } from '../../shared/runner-sandbox-provider.js';
export declare function resolveRuntimeDefaultAdapters(input: {
    executionAdapter?: AgentExecutionAdapter;
    executionAdapters?: AgentExecutionAdapterRegistry;
    runnerSandboxProvider?: RunnerSandboxProvider;
    sandboxSettings: unknown;
    databaseUrl: string | null;
    databaseSchema: string;
    getEgressDenylist: () => readonly string[];
    llmAdapters: {
        createDefaultAgentExecutionAdapterRegistry(): AgentExecutionAdapterRegistry;
        createDefaultInlineAgentLoopLane(input: {
            databaseUrl: string | null;
            databaseSchema: string;
            createCoreTools: (...args: never[]) => unknown;
            getEgressDenylist: () => readonly string[];
        }): unknown;
        createDefaultMemoryLlmClient(): MemoryLlmClient;
        createDefaultRunnerSandboxProvider(input: unknown): RunnerSandboxProvider;
    };
}): {
    executionAdapter: AgentExecutionAdapter;
    executionAdapters: AgentExecutionAdapterRegistry;
    runnerSandboxProvider: RunnerSandboxProvider;
    memoryLlmClient: MemoryLlmClient;
};

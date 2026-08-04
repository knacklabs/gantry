import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
type CompactionPromptAdapter = Pick<AgentExecutionAdapter, 'id' | 'sessionCompactionPrompt'>;
export declare function maintenanceCompactionPromptForExecutionProvider(executionProviderId: string, input: {
    executionAdapter?: CompactionPromptAdapter;
    executionAdapters?: AgentExecutionAdapterRegistry;
}): string | undefined;
export {};

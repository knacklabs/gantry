import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
export declare function resolveRuntimeExecutionProviderId(executionAdapter?: Pick<AgentExecutionAdapter, 'id'>): ExecutionProviderId;
export declare function resolveConfiguredRuntimeExecutionProviderId(input: {
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    executionAdapters?: Pick<AgentExecutionAdapterRegistry, 'list'>;
    fallbackExecutionProviderId?: ExecutionProviderId;
}): ExecutionProviderId;

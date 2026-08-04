import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import { type AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import { type AdapterInlineAgentLoopLane, type AdapterInlineAgentLoopLaneInput, type InlineCoreToolRegistry, type InlineCoreToolSupport } from './inline-lane-dispatcher.js';
export { createRunnerSandboxProvider as createDefaultRunnerSandboxProvider } from '../sandbox/runner-sandbox-provider.js';
export declare function createDefaultAgentExecutionAdapter(): AgentExecutionAdapter;
export declare function createDefaultAgentExecutionAdapterRegistry(): AgentExecutionAdapterRegistry;
export interface DefaultInlineAgentLoopLaneDeps {
    databaseUrl: string | null;
    databaseSchema: string;
    createCoreTools: (input: AdapterInlineAgentLoopLaneInput, support: InlineCoreToolSupport) => InlineCoreToolRegistry | Promise<InlineCoreToolRegistry>;
    getEgressDenylist: () => readonly string[];
}
export declare function createDefaultInlineAgentLoopLane(deps: DefaultInlineAgentLoopLaneDeps): AdapterInlineAgentLoopLane;
export declare function createDefaultMemoryLlmClient(): MemoryLlmClient;

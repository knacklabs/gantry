import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import type { RunnerSandboxProvider } from '../../shared/runner-sandbox-provider.js';
import {
  configureDefaultInlineAgentLoopLane,
  type InlineAgentLoopLane,
  type InlineAgentLoopLaneInput,
} from '../../runtime/agent-inline.js';
import { createInlineCoreTools } from './inline-agent-loop-tools.js';

export function resolveRuntimeDefaultAdapters(input: {
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
} {
  const executionAdapters =
    input.executionAdapters ??
    input.llmAdapters.createDefaultAgentExecutionAdapterRegistry();
  const executionAdapter =
    input.executionAdapter ?? executionAdapters.list()[0];
  if (!executionAdapter) {
    throw new Error('Runtime requires at least one model execution adapter.');
  }
  const runnerSandboxProvider =
    input.runnerSandboxProvider ??
    input.llmAdapters.createDefaultRunnerSandboxProvider(input.sandboxSettings);
  configureDefaultInlineAgentLoopLane(
    input.llmAdapters.createDefaultInlineAgentLoopLane({
      databaseUrl: input.databaseUrl,
      databaseSchema: input.databaseSchema,
      createCoreTools: (laneInput: never, support: never) =>
        createInlineCoreTools(
          laneInput as unknown as InlineAgentLoopLaneInput,
          support as never,
        ) as never,
      getEgressDenylist: input.getEgressDenylist,
    }) as InlineAgentLoopLane,
  );
  return {
    executionAdapter,
    executionAdapters,
    runnerSandboxProvider,
    memoryLlmClient: input.llmAdapters.createDefaultMemoryLlmClient(),
  };
}

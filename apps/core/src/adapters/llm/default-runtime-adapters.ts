import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import {
  createAgentExecutionAdapterRegistry,
  type AgentExecutionAdapterRegistry,
} from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import {
  evaluateNeutralToolPolicy,
  evaluateNeutralToolPreChecks,
} from '../../runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '../../runner/mcp/formatting.js';
import { z } from 'zod';
import { createAnthropicClaudeAgentExecutionAdapter } from './anthropic-claude-agent/execution-adapter.js';
import { runClaudeInlineAgentLoopLane } from './anthropic-claude-agent/inline-lane/index.js';
import { createDeepAgentsLangChainExecutionAdapter } from './deepagents-langchain/execution-adapter.js';
import { deepAgentsCheckpointSchema } from './deepagents-langchain/execution-adapter.js';
import { createDeepAgentsInlineAgentLoopLane } from './deepagents-langchain/inline-lane/index.js';
import { createAnthropicMemoryLlmClient } from './anthropic-claude-agent/memory-llm-client.js';
import { createDirectAnthropicClassifierLlmClient } from './anthropic-claude-agent/permission-classifier-llm-client.js';
import { createOpenAiMemoryLlmClient } from './openai-memory/openai-memory-llm-client.js';
import { createRouteAwareMemoryLlmClient } from './route-aware-memory-llm-client.js';
import {
  createInlineAgentLoopLaneDispatcher,
  type AdapterInlineAgentLoopLane,
  type AdapterInlineAgentLoopLaneInput,
  type InlineCoreToolRegistry,
  type InlineCoreToolSupport,
} from './inline-lane-dispatcher.js';
export { createRunnerSandboxProvider as createDefaultRunnerSandboxProvider } from '../sandbox/runner-sandbox-provider.js';

export function createDefaultAgentExecutionAdapter(): AgentExecutionAdapter {
  return createAnthropicClaudeAgentExecutionAdapter();
}

export function createDefaultAgentExecutionAdapterRegistry(): AgentExecutionAdapterRegistry {
  return createAgentExecutionAdapterRegistry([
    createAnthropicClaudeAgentExecutionAdapter(),
    createDeepAgentsLangChainExecutionAdapter(),
  ]);
}

export interface DefaultInlineAgentLoopLaneDeps {
  databaseUrl: string | null;
  databaseSchema: string;
  createCoreTools: (
    input: AdapterInlineAgentLoopLaneInput,
    support: InlineCoreToolSupport,
  ) => InlineCoreToolRegistry | Promise<InlineCoreToolRegistry>;
  getEgressDenylist: () => readonly string[];
}

export function createDefaultInlineAgentLoopLane(
  deps: DefaultInlineAgentLoopLaneDeps,
): AdapterInlineAgentLoopLane {
  return createInlineAgentLoopLaneDispatcher({
    claudeLane: runClaudeInlineAgentLoopLane,
    deepAgentsLane: createDeepAgentsInlineAgentLoopLane({
      databaseUrl: deps.databaseUrl,
      schema: deepAgentsCheckpointSchema(deps.databaseSchema),
    }),
    createCoreTools: (laneInput) =>
      deps.createCoreTools(laneInput, {
        schemaFactory: z,
        evaluateToolPreChecks: evaluateNeutralToolPreChecks,
        evaluateToolPolicy: evaluateNeutralToolPolicy,
        formatMemorySearchResponse: formatMemoryToolResponse,
        formatMemoryWriteResponse,
      }),
    getEgressDenylist: deps.getEgressDenylist,
  });
}

// The memory engine is derived from the memory model's provider, so this adapter
// needs no engine input: the route-aware client dispatches provider-first
// (DeepAgents-lane providers such as OpenRouter -> OpenAI direct), then falls
// back to the response family (anthropic -> Claude SDK, openai -> OpenAI direct).
export function createDefaultMemoryLlmClient(): MemoryLlmClient {
  return createRouteAwareMemoryLlmClient({
    anthropic: createAnthropicMemoryLlmClient(),
    anthropicSingleRequest: createDirectAnthropicClassifierLlmClient(),
    openai: createOpenAiMemoryLlmClient(),
  });
}

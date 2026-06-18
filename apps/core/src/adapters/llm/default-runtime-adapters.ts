import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import {
  createAgentExecutionAdapterRegistry,
  type AgentExecutionAdapterRegistry,
} from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import { createAnthropicClaudeAgentExecutionAdapter } from './anthropic-claude-agent/execution-adapter.js';
import { createDeepAgentsLangChainExecutionAdapter } from './deepagents-langchain/execution-adapter.js';
import { createAnthropicMemoryLlmClient } from './anthropic-claude-agent/memory-llm-client.js';
import { createOpenAiMemoryLlmClient } from './openai-memory/openai-memory-llm-client.js';
import { createRouteAwareMemoryLlmClient } from './route-aware-memory-llm-client.js';
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

// The memory engine is derived from the memory model's provider, so this adapter
// needs no engine input: the route-aware client dispatches provider-first
// (DeepAgents-lane providers such as OpenRouter -> OpenAI direct), then falls
// back to the response family (anthropic -> Claude SDK, openai -> OpenAI direct).
export function createDefaultMemoryLlmClient(): MemoryLlmClient {
  return createRouteAwareMemoryLlmClient({
    anthropic: createAnthropicMemoryLlmClient(),
    openai: createOpenAiMemoryLlmClient(),
  });
}

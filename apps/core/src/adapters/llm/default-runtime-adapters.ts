import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import {
  createAgentExecutionAdapterRegistry,
  type AgentExecutionAdapterRegistry,
} from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import { createAnthropicClaudeAgentExecutionAdapter } from './anthropic-claude-agent/execution-adapter.js';
import { createAnthropicMemoryLlmClient } from './anthropic-claude-agent/memory-llm-client.js';
export { createRunnerSandboxProvider as createDefaultRunnerSandboxProvider } from '../sandbox/runner-sandbox-provider.js';

export function createDefaultAgentExecutionAdapter(): AgentExecutionAdapter {
  return createAnthropicClaudeAgentExecutionAdapter();
}

export function createDefaultAgentExecutionAdapterRegistry(): AgentExecutionAdapterRegistry {
  return createAgentExecutionAdapterRegistry([
    createAnthropicClaudeAgentExecutionAdapter(),
  ]);
}

export function createDefaultMemoryLlmClient(): MemoryLlmClient {
  return createAnthropicMemoryLlmClient();
}

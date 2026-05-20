import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
import { createAnthropicClaudeAgentExecutionAdapter } from './anthropic-claude-agent/execution-adapter.js';
import { createAnthropicMemoryLlmClient } from './anthropic-claude-agent/memory-llm-client.js';

export function createDefaultAgentExecutionAdapter(): AgentExecutionAdapter {
  return createAnthropicClaudeAgentExecutionAdapter();
}

export function createDefaultMemoryLlmClient(): MemoryLlmClient {
  return createAnthropicMemoryLlmClient();
}

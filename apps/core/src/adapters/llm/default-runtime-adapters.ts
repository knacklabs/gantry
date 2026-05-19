import { createAnthropicClaudeAgentExecutionAdapter } from './anthropic-claude-agent/execution-adapter.js';
import { createAnthropicMemoryLlmClient } from './anthropic-claude-agent/memory-llm-client.js';

export function createDefaultAgentExecutionAdapter() {
  return createAnthropicClaudeAgentExecutionAdapter();
}

export function createDefaultMemoryLlmClient() {
  return createAnthropicMemoryLlmClient();
}

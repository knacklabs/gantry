import { countAnthropicSourceTokens } from './source-token-count.js';
import type { MemoryLlmClient } from '../../../domain/ports/memory-llm-client.js';
import { hasClaudeAuthConfigured, runClaudeQuery } from './memory-query.js';

export function createAnthropicMemoryLlmClient(): MemoryLlmClient {
  return {
    isConfigured: hasClaudeAuthConfigured,
    query: runClaudeQuery,
    countTokens: countAnthropicSourceTokens,
  };
}

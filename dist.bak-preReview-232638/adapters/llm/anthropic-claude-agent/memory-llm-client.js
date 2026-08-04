import { hasClaudeAuthConfigured, runClaudeQuery } from './memory-query.js';
export function createAnthropicMemoryLlmClient() {
    return {
        isConfigured: hasClaudeAuthConfigured,
        query: runClaudeQuery,
    };
}

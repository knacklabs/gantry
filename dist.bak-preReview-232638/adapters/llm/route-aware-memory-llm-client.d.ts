import type { MemoryLlmClient } from '../../domain/ports/memory-llm-client.js';
export interface RouteAwareMemoryLlmClientDeps {
    anthropic: MemoryLlmClient;
    openai: MemoryLlmClient;
    anthropicSingleRequest?: MemoryLlmClient;
}
export declare function createRouteAwareMemoryLlmClient(deps: RouteAwareMemoryLlmClientDeps): MemoryLlmClient;

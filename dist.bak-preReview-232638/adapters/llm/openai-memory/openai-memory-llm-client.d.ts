import type { MemoryLlmClient } from '../../../domain/ports/memory-llm-client.js';
/**
 * Route-aware memory LLM client for the OpenAI response family. It speaks the
 * Chat Completions API over plain fetch (no LangChain/DeepAgents dependency)
 * through the Gantry loopback model gateway, using the same broker authority
 * lane as Anthropic memory queries. cacheStatic is a no-op for OpenAI: prompt
 * caching is automatic on prefix, so there is no per-block cache control.
 */
export declare function createOpenAiMemoryLlmClient(): MemoryLlmClient;

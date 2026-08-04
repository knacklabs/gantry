export type { MemoryLlmClient, MemoryLlmQueryOpts, MemoryLlmUsage, } from '../domain/ports/memory-llm-client.js';
import type { MemoryLlmClient } from '../domain/ports/memory-llm-client.js';
export declare function registerMemoryLlmClient(client: MemoryLlmClient): void;
export declare function getMemoryLlmClient(): MemoryLlmClient;

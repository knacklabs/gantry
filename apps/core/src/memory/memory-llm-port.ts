export type {
  MemoryLlmClient,
  MemoryLlmQueryOpts,
  MemoryLlmUsage,
} from '../domain/ports/memory-llm-client.js';

import type { MemoryLlmClient } from '../domain/ports/memory-llm-client.js';

let registeredClient: MemoryLlmClient | undefined;

export function registerMemoryLlmClient(client: MemoryLlmClient): void {
  registeredClient = client;
}

const unconfiguredMemoryLlmClient: MemoryLlmClient = {
  isConfigured: () => false,
  query: async () => {
    throw new Error(
      'Memory LLM client is not configured. Runtime bootstrap must register a MemoryLlmClient.',
    );
  },
};

export function getMemoryLlmClient(): MemoryLlmClient {
  return registeredClient ?? unconfiguredMemoryLlmClient;
}

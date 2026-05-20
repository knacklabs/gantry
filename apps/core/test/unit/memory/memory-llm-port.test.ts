import { describe, expect, it, vi } from 'vitest';

describe('memory LLM port', () => {
  it('throws when queried before a client is registered', async () => {
    vi.resetModules();
    const { getMemoryLlmClient } =
      await import('@core/memory/memory-llm-port.js');

    const client = getMemoryLlmClient();

    expect(client.isConfigured()).toBe(false);
    await expect(
      client.query({ model: 'test', prompt: 'hello' }),
    ).rejects.toThrow('Memory LLM client is not configured');
  });
});

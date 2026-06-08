import { beforeEach, describe, expect, it, vi } from 'vitest';

const memoryQueryMock = vi.hoisted(() => vi.fn());
const memoryIsConfiguredMock = vi.hoisted(() => vi.fn());

vi.mock('@core/config/index.js', () => ({
  MEMORY_EXTRACTOR_MAX_FACTS: 5,
  MEMORY_EXTRACTOR_MIN_CONFIDENCE: 0.7,
  getMemoryModelRuntimeConfig: () => ({ extractor: 'haiku' }),
}));

vi.mock('@core/memory/memory-llm-port.js', () => ({
  getMemoryLlmClient: () => ({
    isConfigured: memoryIsConfiguredMock,
    query: memoryQueryMock,
  }),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('LlmMemoryExtractionProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    memoryIsConfiguredMock.mockReturnValue(true);
    memoryQueryMock.mockReset();
  });

  it('drops facts grounded only in earlier_context and keeps arc-grounded facts', async () => {
    memoryQueryMock.mockResolvedValue(
      JSON.stringify([
        {
          scope: 'user',
          kind: 'constraint',
          key: 'allergy:peanuts',
          value: 'The user is allergic to peanuts.',
          why: 'I am allergic to peanuts',
          confidence: 0.95,
        },
        {
          scope: 'user',
          kind: 'preference',
          key: 'fruit:mangoes',
          value: 'The user likes Alphonso mangoes.',
          why: 'I love Alphonso mangoes',
          confidence: 0.95,
        },
      ]),
    );
    const { LlmMemoryExtractionProvider } = await import(
      '@core/memory/extractor-llm.js'
    );
    const provider = new LlmMemoryExtractionProvider();

    const result = await provider.extractFactsWithOutcome({
      contextTurns: [
        { role: 'user', text: 'I am allergic to peanuts' },
        { role: 'assistant', text: 'Noted.' },
      ],
      turns: [
        { role: 'user', text: 'I love Alphonso mangoes' },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
      userId: 'user-1',
    });

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      key: 'fruit:mangoes',
      why: 'I love Alphonso mangoes',
    });
    const queryInput = memoryQueryMock.mock.calls[0]?.[0] as {
      prompt: string;
      userBlocks?: Array<{ text: string }>;
    };
    const dynamicUserBlock = queryInput.userBlocks?.[1]?.text ?? '';
    expect(dynamicUserBlock.indexOf('"earlier_context"')).toBeGreaterThan(-1);
    expect(dynamicUserBlock.indexOf('"session_arc"')).toBeGreaterThan(-1);
    expect(dynamicUserBlock).toContain(
      'NEVER extract facts from it',
    );
  });
});

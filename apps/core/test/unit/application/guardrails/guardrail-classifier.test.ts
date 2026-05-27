import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeQuery = vi.fn();

const { createGuardrailClassifier } = await import(
  '@core/application/guardrails/guardrail-classifier.js'
);

describe('Guardrail classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves aliases through the model catalog and returns parsed JSON', async () => {
    mockRunClaudeQuery.mockResolvedValue(
      '{"action":"allow","reason":"bss_support"}',
    );

    const classifier = createGuardrailClassifier({
      query: (...args) => mockRunClaudeQuery(...args),
    });
    const result = await classifier({
      policy: 'bss_customer_support',
      model: 'haiku',
      messages: ['Can you help me with my sweets?'],
      prompt: 'classify',
    });

    expect(mockRunClaudeQuery).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'classify',
      disableTools: true,
      prompt: JSON.stringify(
        {
          policy: 'bss_customer_support',
          messages: ['Can you help me with my sweets?'],
        },
        null,
        2,
      ),
    });
    expect(result).toEqual({ action: 'allow', reason: 'bss_support' });
  });

  it('rejects raw provider model ids before calling the provider', async () => {
    const classifier = createGuardrailClassifier({
      query: (...args) => mockRunClaudeQuery(...args),
    });

    await expect(
      classifier({
        policy: 'bss_customer_support',
        model: 'claude-haiku-4-5-20251001',
        messages: ['Can you help?'],
        prompt: 'classify',
      }),
    ).rejects.toThrow('Provider model ID');
    expect(mockRunClaudeQuery).not.toHaveBeenCalled();
  });
});

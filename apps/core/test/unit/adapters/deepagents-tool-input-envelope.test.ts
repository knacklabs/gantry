import { tool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { envelopeToolsForProvider } from '../../../src/adapters/llm/deepagents-langchain/runner/tool-input-envelope.js';

describe('DeepAgents tool-input envelope', () => {
  it('uses a portable JSON string at the provider boundary and invokes the original tool', async () => {
    const invoked = vi.fn(async (input: { payload: Record<string, unknown> }) => input);
    const original = tool(invoked, {
      name: 'browser_act',
      description: 'Perform a browser action.',
      schema: z.object({ payload: z.record(z.string(), z.unknown()) }),
    });

    const [wrapped] = envelopeToolsForProvider([original], 'gemini');
    expect(wrapped).not.toBe(original);
    expect(wrapped?.description).toContain('"payload"');
    await wrapped?.invoke({ json: '{"payload":{"selector":"#open"}}' });
    expect(invoked).toHaveBeenCalledWith(
      { payload: { selector: '#open' } },
      expect.anything(),
    );
  });

  it('leaves other providers unchanged', () => {
    const original = tool(async () => 'ok', {
      name: 'simple',
      description: 'Simple.',
      schema: z.object({}),
    });
    expect(envelopeToolsForProvider([original], 'openai')).toEqual([original]);
  });

  it('returns browser validation failures to the model for correction', async () => {
    const original = tool(
      async () => {
        throw new Error('profile="full" and reason are required');
      },
      {
        name: 'browser_act',
        description: 'Perform a browser action.',
        schema: z.object({ action: z.string() }),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'gemini');

    await expect(
      wrapped?.invoke({ json: '{"action":"evaluate"}' }),
    ).resolves.toContain('Correct the arguments');
    await expect(wrapped?.invoke({ json: '{broken' })).resolves.toContain(
      'not valid JSON',
    );
  });
});

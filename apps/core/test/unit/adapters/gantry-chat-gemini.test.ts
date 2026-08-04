import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  GantryChatGemini,
  preserveGeminiThoughtSignatures,
} from '../../../src/adapters/llm/deepagents-langchain/runner/gantry-chat-gemini.js';

describe('GantryChatGemini', () => {
  it('replays raw function calls so Gemini thought signatures survive', () => {
    const rawToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'browser_open', arguments: '{"json":"{}"}' },
      extra_content: { google: { thought_signature: 'opaque-signature' } },
    };
    const assistant = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call-1', name: 'browser_open', args: { json: '{}' }, type: 'tool_call' },
      ],
      additional_kwargs: { tool_calls: [rawToolCall] },
    });
    const human = new HumanMessage('open the site');

    const [projectedHuman, projectedAssistant] =
      preserveGeminiThoughtSignatures([human, assistant]);

    expect(projectedHuman).toBe(human);
    expect((projectedAssistant as AIMessage).tool_calls).toEqual([]);
    expect(projectedAssistant?.additional_kwargs.tool_calls).toEqual([
      rawToolCall,
    ]);
  });

  it('retains the signature-preserving transport after tools are bound', () => {
    const model = new GantryChatGemini({
      model: 'gemini-test',
      apiKey: 'test-key',
      configuration: { baseURL: 'http://127.0.0.1:4567/gemini' },
      disableStreaming: true,
    });
    const bound = model.bindTools([
      { name: 'status', description: 'Status.', schema: z.object({}) },
    ]);

    expect(
      (bound as unknown as { completions: { constructor: { name: string } } })
        .completions.constructor.name,
    ).toBe('SignaturePreservingGeminiCompletions');
  });
});

import { describe, expect, it } from 'vitest';

import {
  normalizeDeepAgentStream,
  type LangGraphStreamEvent,
} from '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer.js';
import type { RunnerOutputFrame } from '@core/runner/runner-frame.js';

async function* asStream(
  events: LangGraphStreamEvent[],
): AsyncIterable<LangGraphStreamEvent> {
  for (const event of events) yield event;
}

function streamEvent(text: string, usage?: { input: number; output: number }) {
  return {
    event: 'on_chat_model_stream',
    data: {
      chunk: {
        content: text,
        ...(usage
          ? {
              usage_metadata: {
                input_tokens: usage.input,
                output_tokens: usage.output,
              },
            }
          : {}),
      },
    },
  } satisfies LangGraphStreamEvent;
}

describe('normalizeDeepAgentStream', () => {
  it('emits ONLY token-delta frames and returns the terminal payload (no final frame here)', async () => {
    const frames: RunnerOutputFrame[] = [];
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('Hello '),
        streamEvent('world', { input: 120, output: 8 }),
      ]),
      newSessionId: 'session-1',
      modelId: 'gpt-5.5',
      modelProfile: { maxInputTokens: 400_000 },
      emit: (frame) => frames.push(frame),
    });

    expect(result.text).toBe('Hello world');
    // R2: the normalizer no longer emits a terminal frame; the caller owns the
    // single per-turn terminal marker. So only the two delta frames appear, and
    // none of them is a usage/terminal frame.
    expect(frames.map((frame) => frame.result)).toEqual(['Hello ', 'world']);
    expect(frames.every((f) => f.usage === undefined)).toBe(true);
    expect(frames.every((f) => f.newSessionId === 'session-1')).toBe(true);

    // The terminal payload is returned for the caller to emit.
    expect(result.terminalResult).toBeNull(); // partial text streamed
    expect(result.terminalUsage).toMatchObject({
      model: 'gpt-5.5',
      inputTokens: 120,
      outputTokens: 8,
      totalBillableInputTokens: 120,
      cacheProvider: 'none',
    });
    expect(result.terminalContextUsage).toMatchObject({
      maxTokens: 400_000,
      totalTokens: 128,
      model: 'gpt-5.5',
      apiUsage: {
        input_tokens: 120,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  it('reports zero max tokens when the model profile omits a context window', async () => {
    const result = await normalizeDeepAgentStream({
      events: asStream([streamEvent('hi', { input: 10, output: 2 })]),
      newSessionId: 'session-2',
      modelId: 'gpt-5.5',
      modelProfile: {},
      emit: () => {},
    });
    expect(result.terminalContextUsage.maxTokens).toBe(0);
    expect(result.terminalContextUsage.percentage).toBe(0);
  });

  it('keeps the cumulative (largest) usage across multiple chunks', async () => {
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('a', { input: 50, output: 1 }),
        streamEvent('b', { input: 50, output: 4 }),
      ]),
      newSessionId: 'session-3',
      modelProfile: { maxInputTokens: 1000 },
      emit: () => {},
    });
    expect(result.terminalUsage.inputTokens).toBe(50);
    expect(result.terminalUsage.outputTokens).toBe(4);
  });

  it('returns the assistant text as the terminal result when no partial text streamed', async () => {
    const frames: RunnerOutputFrame[] = [];
    const result = await normalizeDeepAgentStream({
      events: asStream([
        {
          event: 'on_chat_model_end',
          data: {
            output: { usage_metadata: { input_tokens: 5, output_tokens: 3 } },
          },
        },
      ]),
      newSessionId: 'session-4',
      modelProfile: { maxInputTokens: 1000 },
      emit: (frame) => frames.push(frame),
    });
    // No delta frames emitted (no streamed text).
    expect(frames).toHaveLength(0);
    expect(result.terminalResult).toBeNull();
    expect(result.terminalUsage.outputTokens).toBe(3);
  });
});

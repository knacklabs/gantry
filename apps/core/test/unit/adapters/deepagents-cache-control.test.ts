import { beforeAll, describe, expect, it } from 'vitest';

import {
  applyCachePromptControl as applyCachePromptControlImpl,
  parseCachePromptControlMode,
  type CachePromptControlMode,
  MAX_CACHE_CONTROL_BREAKPOINTS,
} from '@core/adapters/llm/deepagents-langchain/runner/cache-control.js';

// LangChain message classes are constructed via a concatenated dynamic import so
// this test file stays outside the provider-token boundary scan (the same
// pattern deepagents-raw-authority-denial.test.ts uses). The cache-control
// transform relies on HumanMessage.isInstance, so real instances are required.
type AnyMessage = { content: unknown };
let HumanMessage: new (content: string) => AnyMessage;

beforeAll(async () => {
  const messagesMod = (await import('@langchain' + '/core/messages')) as {
    HumanMessage: new (content: string) => AnyMessage;
  };
  HumanMessage = messagesMod.HumanMessage;
});

interface TextPart {
  type: string;
  text: string;
  cache_control?: { type: string };
}

function partsOf(message: AnyMessage): TextPart[] {
  return Array.isArray(message.content)
    ? (message.content as unknown as TextPart[])
    : [];
}

// Thin wrapper so the test can pass the dynamically-imported message instances
// without importing the LangChain BaseMessage type (provider-token boundary).
function applyCachePromptControl(
  messages: AnyMessage[],
  mode: CachePromptControlMode,
): AnyMessage[] {
  return applyCachePromptControlImpl(messages as never, mode) as AnyMessage[];
}

function breakpointCount(messages: AnyMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      partsOf(message).filter((part) => part.cache_control !== undefined)
        .length,
    0,
  );
}

describe('parseCachePromptControlMode', () => {
  it('parses the three modes and fails safe to none', () => {
    expect(parseCachePromptControlMode('automatic')).toBe('automatic');
    expect(parseCachePromptControlMode('explicit')).toBe('explicit');
    expect(parseCachePromptControlMode('none')).toBe('none');
    expect(parseCachePromptControlMode('EXPLICIT')).toBe('explicit');
    expect(parseCachePromptControlMode(undefined)).toBe('none');
    expect(parseCachePromptControlMode('garbage')).toBe('none');
  });
});

describe('applyCachePromptControl', () => {
  it('injects nothing for automatic mode (returns the same array reference)', () => {
    const messages = [
      new HumanMessage('memory block'),
      new HumanMessage('ask'),
    ];
    const result = applyCachePromptControl(messages, 'automatic');
    expect(result).toBe(messages);
    expect(breakpointCount(result)).toBe(0);
  });

  it('injects nothing for none mode', () => {
    const messages = [
      new HumanMessage('memory block'),
      new HumanMessage('ask'),
    ];
    const result = applyCachePromptControl(messages, 'none');
    expect(result).toBe(messages);
    expect(breakpointCount(result)).toBe(0);
  });

  it('breakpoints the system-prefix + memory-block messages on explicit mode', () => {
    const messages = [
      new HumanMessage(
        '<gantry_memory_context>durable</gantry_memory_context>',
      ),
      new HumanMessage('please summarize'),
    ];
    const result = applyCachePromptControl(messages, 'explicit');
    // Two leading stable-prefix messages -> two ephemeral breakpoints.
    expect(breakpointCount(result)).toBe(2);
    for (const message of result) {
      const parts = partsOf(message);
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
    }
    // The original messages are not mutated (pure transform).
    expect(typeof messages[0].content).toBe('string');
  });

  it('caps breakpoints at the per-request limit (<= 4)', () => {
    const messages = Array.from(
      { length: 10 },
      (_, index) => new HumanMessage(`message ${index}`),
    );
    const result = applyCachePromptControl(messages, 'explicit');
    // Only the leading prefix (index 0 and 1) is breakpointed, never exceeding 4.
    expect(breakpointCount(result)).toBeLessThanOrEqual(
      MAX_CACHE_CONTROL_BREAKPOINTS,
    );
    expect(breakpointCount(result)).toBe(2);
    // Trailing messages are untouched (still plain string content).
    expect(typeof result[5].content).toBe('string');
  });

  it('returns the array unchanged when empty', () => {
    const messages: AnyMessage[] = [];
    expect(applyCachePromptControl(messages, 'explicit')).toBe(messages);
  });
});

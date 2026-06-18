import { describe, expect, it } from 'vitest';

import { buildTurnMessages } from '@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js';
import { composeDeepAgentSystemPrompt } from '@core/adapters/llm/deepagents-langchain/runner/system-prompt.js';
import type { DeepAgentRunnerInput } from '@core/adapters/llm/deepagents-langchain/runner/types.js';

const MEMORY_BLOCK =
  '<gantry_memory_context trust="untrusted_data_only">\nuser prefers metric units\n</gantry_memory_context>';

function input(
  overrides: Partial<DeepAgentRunnerInput> = {},
): DeepAgentRunnerInput {
  return {
    prompt: 'what units should I use?',
    workspaceFolder: 'main_agent',
    chatJid: 'tg:group',
    ...overrides,
  };
}

describe('DeepAgents memory context placement', () => {
  it('injects the trust-scoped memory block exactly once as a model-visible user message', () => {
    const messages = buildTurnMessages(
      input({ memoryContextBlock: MEMORY_BLOCK }),
      [],
    );
    const serialized = messages.map((message) => String(message.content));
    const occurrences = serialized.filter((content) =>
      content.includes('<gantry_memory_context trust="untrusted_data_only">'),
    );
    expect(occurrences).toHaveLength(1);
    // It rides on a user (Human) message, not a system message — prompt context,
    // not system authority. The user prompt is the last message after it.
    const memoryIndex = serialized.findIndex((content) =>
      content.includes('<gantry_memory_context'),
    );
    const promptIndex = serialized.findIndex((content) =>
      content.includes('what units should I use?'),
    );
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThan(memoryIndex);
    expect(messages[memoryIndex].getType()).toBe('human');
  });

  it('does not inject a memory message when no memory block is present', () => {
    const messages = buildTurnMessages(input(), []);
    const serialized = messages.map((message) => String(message.content));
    expect(
      serialized.some((content) => content.includes('gantry_memory_context')),
    ).toBe(false);
    expect(messages).toHaveLength(1);
  });

  it('adds the durable-memory boundary policy to the system prompt (framing, not the tag)', () => {
    const systemPrompt = composeDeepAgentSystemPrompt(
      input({
        memoryContextBlock: MEMORY_BLOCK,
        compiledSystemPrompt: 'You are a helpful assistant.',
      }),
    );
    expect(systemPrompt).toContain('Gantry Durable Memory Boundary');
    expect(systemPrompt).toContain('untrusted data');
    expect(systemPrompt).toContain('You are a helpful assistant.');
    // The trust-tagged block itself stays in the user message, not the system
    // prompt (it must not become system authority).
    expect(systemPrompt).not.toContain('<gantry_memory_context');
  });
});

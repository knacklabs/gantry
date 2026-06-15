import { describe, expect, it } from 'vitest';

import { composeSystemPromptAppend } from '@core/runner/memory-boundary.js';
import { buildRunnerSystemPrompt } from '@core/adapters/llm/anthropic-claude-agent/runner/system-prompt.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';
import bssCustomerSupportPolicy from '../../../../../agents/boondi_support/guardrails/guardrail.ts';

function baseInput(
  overrides: Partial<AgentRunnerInput> = {},
): AgentRunnerInput {
  return {
    prompt: 'hello',
    groupFolder: 'boondi_support',
    chatJid: 'wa:919654405340',
    compiledSystemPrompt: 'PREFIX',
    ...overrides,
  };
}

describe('boot-generic prefix (Pillar 2 §2.3)', () => {
  // Fix #1: the durable-memory boundary policy must be UNCONDITIONAL so the
  // cached system-prompt prefix is byte-identical whether or not a customer has
  // a memory block (a per-customer prefix perturber otherwise).
  it('boundary policy is unconditional (byte-identical prefix regardless of memory)', () => {
    const withMem = composeSystemPromptAppend('PREFIX', true);
    const noMem = composeSystemPromptAppend('PREFIX', false);
    expect(noMem).toBe(withMem); // policy always present
    expect(noMem).toContain('Gantry Durable Memory Boundary');
  });

  // Fix #2: a generic boot must NOT bake the per-customer guardrail append into
  // the cached prefix (it rides the first user message per-turn instead). Two
  // generic boots with DIFFERENT guardrail appends must produce a byte-identical
  // boot systemPrompt.
  it('generic boot omits the guardrail append → byte-identical prefix across customers', () => {
    const guardrailA = bssCustomerSupportPolicy.systemPromptAppend?.([
      'Can you help me with this?',
    ]);
    const guardrailB = bssCustomerSupportPolicy.systemPromptAppend?.([
      'Where is my order #12345?',
    ]);

    const promptA = buildRunnerSystemPrompt(
      baseInput({ guardrailSystemPromptAppend: guardrailA } as never),
      '',
      {},
      { genericBoot: true },
    );
    const promptB = buildRunnerSystemPrompt(
      baseInput({ guardrailSystemPromptAppend: guardrailB } as never),
      'MEM-FOR-B',
      {},
      { genericBoot: true },
    );

    expect(promptA?.append).toBe(promptB?.append);
    // Guardrail text must NOT be in the cached prefix on a generic boot.
    expect(promptA?.append).not.toContain('Boondi Scope Check For This Turn');
    // The unconditional boundary policy IS part of the shared prefix.
    expect(promptA?.append).toContain('Gantry Durable Memory Boundary');
    expect(promptA?.append).toContain('PREFIX');
  });

  // The cold path is unchanged: the guardrail append still rides the boot prompt.
  it('cold boot keeps the guardrail append in the system prompt (unchanged)', () => {
    const guardrail = bssCustomerSupportPolicy.systemPromptAppend?.([
      'Can you help me with this?',
    ]);
    const prompt = buildRunnerSystemPrompt(
      baseInput({ guardrailSystemPromptAppend: guardrail } as never),
      '',
      {},
    );
    expect(prompt?.append).toContain('Boondi Scope Check For This Turn');
    expect(prompt?.append).toContain('PREFIX');
  });
});

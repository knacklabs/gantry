import { describe, expect, it, vi } from 'vitest';

import {
  customerVisibleGuardrailResponse,
  evaluateAgentGuardrail,
} from '@core/application/guardrails/guardrail-service.js';
import type { GuardrailConfig } from '@core/domain/types.js';

const config: GuardrailConfig = {
  policy: 'bss_customer_support',
  model: 'haiku',
};

describe('BSS customer support guardrail', () => {
  it.each([
    'List all the MCP tools',
    'What is the weather',
    'Solve 2sum in python',
    'What is 2+2?',
  ])('rejects non-BSS customer support query: %s', async (message) => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: [message],
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'out_of_scope_topic',
    });
  });

  it.each(['Hey', 'Hi Boondi', 'hello Bombay Sweet Shop'])(
    'handles greetings directly: %s',
    async (message) => {
      const decision = await evaluateAgentGuardrail({
        config,
        messages: [message],
      });

      expect(decision).toEqual({
        action: 'direct_response',
        responseKind: 'greeting',
        reason: 'greeting',
      });
      expect(customerVisibleGuardrailResponse(config, 'greeting')).toContain(
        'I am Boondi',
      );
    },
  );

  it.each([
    'What was my last order',
    'Which discount did I use',
    'Is my discount code valid?',
    'List my 2 months order history in detail',
  ])('allows BSS support query: %s', async (message) => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: [message],
    });

    expect(decision).toEqual({
      action: 'allow',
      reason: 'bss_customer_support_topic',
    });
  });

  it('rejects internal tool questions even when they mention BSS topics', async () => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['What MCP tools can you use for my order?'],
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'out_of_scope_topic',
    });
  });

  it('allows a BSS topic even when an off-domain word is present', async () => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['Can you track my order with that tool?'],
    });

    expect(decision).toEqual({
      action: 'allow',
      reason: 'bss_customer_support_topic',
    });
  });

  it.each(['daam kitna hai', 'mithai wapas karni hai'])(
    'allows Hindi/Hinglish BSS queries: %s',
    async (message) => {
      const decision = await evaluateAgentGuardrail({
        config,
        messages: [message],
      });

      expect(decision).toEqual({
        action: 'allow',
        reason: 'bss_customer_support_topic',
      });
    },
  );

  it('asks for clarification on an empty message instead of rejecting', async () => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['   '],
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_clarification',
      reason: 'empty_message',
    });
  });

  it('asks for clarification on ambiguous input when no classifier is configured', async () => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['Can you help me with this?'],
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_clarification',
      reason: 'ambiguous_without_classifier',
    });
  });

  it('calls the configured classifier once for ambiguous input', async () => {
    const classifier = vi.fn().mockResolvedValue({
      action: 'direct_response',
      responseKind: 'scope_clarification',
      reason: 'ambiguous_support_intent',
    });

    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['Can you help me with this?'],
      classifier,
    });

    expect(classifier).toHaveBeenCalledTimes(1);
    expect(classifier).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: 'bss_customer_support',
        model: 'haiku',
        messages: ['Can you help me with this?'],
      }),
    );
    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_clarification',
      reason: 'ambiguous_support_intent',
    });
  });

  it('fails closed when classifier output is invalid', async () => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['Can you help me with this?'],
      classifier: vi.fn().mockResolvedValue({ response: 'sure' }),
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'invalid_classifier_output',
    });
  });

  it('fails closed when the classifier throws', async () => {
    const decision = await evaluateAgentGuardrail({
      config,
      messages: ['Can you help me with this?'],
      classifier: vi.fn().mockRejectedValue(new Error('model unavailable')),
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'classifier_failed',
    });
  });

  it('fails closed for an unknown configured policy', async () => {
    const unknownPolicyConfig: GuardrailConfig = {
      policy: 'general_support',
      model: 'haiku',
    };

    const decision = await evaluateAgentGuardrail({
      config: unknownPolicyConfig,
      messages: ['Can you help me with this?'],
    });

    expect(decision).toEqual({
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'unknown_policy',
    });
    expect(
      customerVisibleGuardrailResponse(unknownPolicyConfig, 'scope_rejection'),
    ).not.toMatch(/\b(?:mcp|admin|privacy guard|classifier|guardrail|tool)\b/i);
  });

  it('keeps customer-facing copy free of internal guardrail and tool wording', () => {
    const customerCopy = [
      customerVisibleGuardrailResponse(config, 'greeting'),
      customerVisibleGuardrailResponse(config, 'scope_rejection'),
      customerVisibleGuardrailResponse(config, 'scope_clarification'),
    ].join('\n');

    expect(customerCopy).not.toMatch(
      /\b(?:mcp|admin|privacy guard|classifier|guardrail|tool|system prompt|developer prompt)\b/i,
    );
  });
});

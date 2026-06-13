import { describe, expect, it, vi } from 'vitest';
import type { ConversationRoute, NewMessage } from '@core/domain/types.js';

const classifier = vi.fn(async () => ({
  action: 'direct_response',
  responseKind: 'scope_rejection',
  reason: 'classifier_should_not_run',
}));

vi.mock('@core/application/guardrails/policy-registry.js', () => ({
  resolveGuardrailPolicy: vi.fn(async () => ({
    source: 'plugin',
    policy: {
      id: 'test_policy',
      prompt: 'classifier prompt',
      evaluateDeterministic: vi.fn(() => null),
      systemPromptAppend: vi.fn(
        () => 'Inline guardrail check before answering.',
      ),
      directResponse: vi.fn(() => 'not used'),
    },
  })),
}));

const { handlePreAgentGuardrail } =
  await import('@core/runtime/group-guardrail.js');

function makeGroup(): ConversationRoute {
  return {
    name: 'Boondi',
    folder: 'boondi_support',
    trigger: 'Boondi',
    added_at: '2026-01-01',
    requiresTrigger: false,
    agentConfig: {
      plugins: {
        guardrail: {
          file: 'guardrail.ts',
          model: 'haiku',
          mode: 'deterministic',
          unresolved: 'inline',
        },
      },
    },
  };
}

function makeMessage(): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'wa:000000043',
    sender: 'wa:000000043',
    sender_name: 'Customer',
    content: 'Can you help me with this?',
    timestamp: '1700000001',
    is_from_me: false,
    is_bot_message: false,
  };
}

describe('pre-agent guardrail inline system prompt', () => {
  it('falls through to the agent with a run-local guardrail prompt when deterministic screening is inconclusive', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage();

    const result = await handlePreAgentGuardrail({
      group: makeGroup(),
      messages: [message],
      latestMessage: message,
      chatJid: message.chat_jid,
      queueJid: message.chat_jid,
      guardrailClassifier: classifier,
      sendMessage,
      buildMessageOptions: () => undefined,
      setCursor: vi.fn(),
      saveState: vi.fn(),
      info: vi.fn(),
    } as never);

    // toMatchObject (not toEqual): the result also carries an additive
    // `guardrailTrace` (WS2 latency capture) that this WS1 assertion ignores.
    expect(result).toMatchObject({
      handled: false,
      systemPromptAppend: 'Inline guardrail check before answering.',
      guardrailReason: 'inconclusive_inline_guardrail',
    });
    expect(classifier).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

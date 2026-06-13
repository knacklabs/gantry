import { describe, expect, it, vi } from 'vitest';
import type { ConversationRoute, NewMessage } from '@core/domain/types.js';

// Deterministic policy: allows directly (no classifier, no inline).
vi.mock('@core/application/guardrails/policy-registry.js', () => ({
  resolveGuardrailPolicy: vi.fn(async () => ({
    source: 'plugin',
    policy: {
      id: 'trace_policy',
      prompt: 'classifier prompt',
      evaluateDeterministic: vi.fn(() => ({ action: 'allow' })),
      directResponse: vi.fn(() => 'canned reply'),
    },
  })),
}));

const { handlePreAgentGuardrail } = await import(
  '@core/runtime/group-guardrail.js'
);

function makeGroup(mode?: 'both' | 'deterministic' | 'classifier'): ConversationRoute {
  return {
    name: 'Agent',
    folder: 'some_agent',
    trigger: 'Agent',
    added_at: '2026-01-01',
    requiresTrigger: false,
    agentConfig: {
      plugins: {
        guardrail: {
          file: 'guardrail.ts',
          model: 'haiku',
          ...(mode ? { mode } : {}),
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
    content: 'order status please',
    timestamp: '1700000001',
    is_from_me: false,
    is_bot_message: false,
  };
}

describe('pre-agent guardrail trace', () => {
  it('attaches a guardrailTrace with ms, startedAt and detail on the allow path', async () => {
    const message = makeMessage();
    const result = await handlePreAgentGuardrail({
      group: makeGroup(),
      messages: [message],
      latestMessage: message,
      chatJid: 'wa:000000043',
      queueJid: 'wa:000000043',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      buildMessageOptions: () => undefined,
      setCursor: vi.fn(),
      saveState: vi.fn(),
      info: vi.fn(),
    });

    expect(result.handled).toBe(false);
    expect(result.guardrailTrace).toBeDefined();
    const trace = result.guardrailTrace!;
    expect(typeof trace.ms).toBe('number');
    expect(trace.ms).toBeGreaterThanOrEqual(0);
    expect(typeof trace.startedAt).toBe('number');
    expect(trace.detail.decision).toBe('allow');
    expect(trace.detail.inlineAttached).toBe(false);
    expect(typeof trace.detail.mode).toBe('string');
  });

  it('attaches a guardrailTrace on the direct_response (handled) path too', async () => {
    // Force a direct_response by mocking the policy to reject deterministically.
    vi.resetModules();
    vi.doMock('@core/application/guardrails/policy-registry.js', () => ({
      resolveGuardrailPolicy: vi.fn(async () => ({
        source: 'plugin',
        policy: {
          id: 'reject_policy',
          prompt: 'p',
          evaluateDeterministic: vi.fn(() => ({
            action: 'direct_response',
            responseKind: 'scope_rejection',
            reason: 'out_of_scope',
          })),
          directResponse: vi.fn(() => 'Sorry, that is out of scope.'),
        },
      })),
    }));
    const mod = await import('@core/runtime/group-guardrail.js');
    const message = makeMessage();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = await mod.handlePreAgentGuardrail({
      group: makeGroup('deterministic'),
      messages: [message],
      latestMessage: message,
      chatJid: 'wa:000000043',
      queueJid: 'wa:000000043',
      sendMessage,
      buildMessageOptions: () => undefined,
      setCursor: vi.fn(),
      saveState: vi.fn(),
      info: vi.fn(),
    });

    expect(result.handled).toBe(true);
    expect(sendMessage).toHaveBeenCalled();
    expect(result.guardrailTrace).toBeDefined();
    expect(result.guardrailTrace!.detail.decision).toBe('direct_response');
    expect(result.guardrailTrace!.detail.reason).toBe('out_of_scope');
    vi.doUnmock('@core/application/guardrails/policy-registry.js');
  });
});

import { describe, expect, it } from 'vitest';
import { LlmTurnAccumulator } from '@core/adapters/llm/anthropic-claude-agent/runner/llm-turn-accumulator.js';

/** Minimal BetaUsage-shaped object. */
function usage(over: Partial<Record<string, number>> = {}) {
  return {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
    ...over,
  };
}

describe('LlmTurnAccumulator', () => {
  it('measures generation time from message_start (onTurnStart) to the assistant message', () => {
    const acc = new LlmTurnAccumulator();
    acc.onTurnStart(1000); // message_start: generation begins
    acc.onAssistant(
      {
        message: {
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: usage(),
        },
      },
      1800, // assistant message: generation done
    );
    acc.closeOpenTurn(1810); // result boundary, slightly later — must NOT extend ms
    const turns = acc.turns();
    expect(turns.length).toBe(1);
    expect(turns[0].startedAt).toBe(1000);
    expect(turns[0].ms).toBe(800); // 1800 - 1000 (generation), not 10 (1810 - 1800)
    expect(turns[0].detail).toEqual({
      model: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
      tokens: { in: 100, out: 20, cacheRead: 80, cacheWrite: 0 },
    });
  });

  it('measures each turn only over its own generation, excluding the inter-turn gap (tool calls)', () => {
    // A tool-using reply: turn 1 emits a tool_use, the tool runs (a long gap with
    // no LLM activity), then turn 2 generates the answer. Each turn must reflect
    // ITS generation time — the tool gap belongs to the tool stage, not the LLM.
    const acc = new LlmTurnAccumulator();
    acc.onTurnStart(100);
    acc.onAssistant(
      { message: { id: 'm1', stop_reason: 'tool_use', usage: usage() } },
      500,
    ); // gen 400
    // tool runs 500 -> 2000 (no LLM events)
    acc.onTurnStart(2000);
    acc.onAssistant(
      { message: { id: 'm2', stop_reason: 'end_turn', usage: usage() } },
      2300,
    ); // gen 300
    acc.closeOpenTurn(2310);
    const turns = acc.turns();
    expect(turns.map((t) => t.ms)).toEqual([400, 300]); // gap 500->2000 excluded
    expect(turns[0].startedAt).toBe(100);
    expect(turns[1].startedAt).toBe(2000);
  });

  it('falls back to the close boundary when no message_start was seen (never 0ms)', () => {
    const acc = new LlmTurnAccumulator();
    acc.onAssistant({ message: { usage: usage() } }, 2000); // no onTurnStart
    acc.closeOpenTurn(2300);
    expect(acc.turns()[0].ms).toBe(300); // 2300 - 2000 (degraded fallback)
  });

  it('maps BetaUsage cache fields, defaulting missing cache counts to 0', () => {
    const acc = new LlmTurnAccumulator();
    acc.onTurnStart(0);
    acc.onAssistant(
      { message: { usage: { input_tokens: 7, output_tokens: 3 } } },
      5,
    );
    acc.closeOpenTurn(9);
    expect(acc.turns()[0].detail.tokens).toEqual({
      in: 7,
      out: 3,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('captures input/output payloads only when payload capture is enabled', () => {
    const on = new LlmTurnAccumulator({ capturePayloads: true });
    on.onTurnStart(0);
    on.onAssistant({ message: { usage: usage() } }, 10, {
      input: 'IN',
      output: 'OUT',
    });
    on.closeOpenTurn(15);
    expect(on.turns()[0].input).toBe('IN');
    expect(on.turns()[0].output).toBe('OUT');

    const off = new LlmTurnAccumulator({ capturePayloads: false });
    off.onTurnStart(0);
    off.onAssistant({ message: { usage: usage() } }, 10, {
      input: 'IN',
      output: 'OUT',
    });
    off.closeOpenTurn(15);
    expect(off.turns()[0].input).toBeUndefined();
    expect(off.turns()[0].output).toBeUndefined();
  });

  it('records no turns when no assistant message was seen', () => {
    const acc = new LlmTurnAccumulator();
    acc.onTurnStart(10);
    acc.closeOpenTurn(100);
    expect(acc.turns()).toEqual([]);
  });

  it('merges assistant events that share a message id into one turn (text + tool_use)', () => {
    // One Anthropic message is emitted by the SDK as two assistant events — a
    // text block then a tool_use block — sharing the same message.id. They must
    // collapse into ONE turn, and the generation span extends to the last event.
    const acc = new LlmTurnAccumulator({ capturePayloads: true });
    acc.onTurnStart(100);
    acc.onAssistant({ message: { id: 'msg_1', usage: usage() } }, 500, {
      output: 'hello',
      input: 'PROMPT',
    });
    acc.onAssistant({ message: { id: 'msg_1', usage: usage() } }, 520, {
      output: '',
    });
    acc.closeOpenTurn(600);
    const turns = acc.turns();
    expect(turns.length).toBe(1);
    expect(turns[0].output).toBe('hello');
    expect(turns[0].input).toBe('PROMPT');
    expect(turns[0].startedAt).toBe(100);
    expect(turns[0].ms).toBe(420); // 520 (last event) - 100; excludes gap to close
  });

  it('finalizes the open turn tokens + stop_reason from the message_delta usage, without changing the measured generation time', () => {
    // The assistant event carries only a mid-stream usage snapshot (out=1); the
    // authoritative final output_tokens arrive in the message_delta — but that
    // event must not stretch the turn's duration.
    const acc = new LlmTurnAccumulator();
    acc.onTurnStart(0);
    acc.onAssistant(
      { message: { id: 'msg_1', usage: usage({ output_tokens: 1 }) } },
      100,
    );
    acc.onFinalUsage(
      usage({
        output_tokens: 134,
        input_tokens: 1,
        cache_read_input_tokens: 9824,
        cache_creation_input_tokens: 435,
      }),
      'end_turn',
    );
    acc.closeOpenTurn(110);
    const t = acc.turns()[0];
    expect(t.detail.tokens).toEqual({
      in: 1,
      out: 134,
      cacheRead: 9824,
      cacheWrite: 435,
    });
    expect(t.detail.stopReason).toBe('end_turn');
    expect(t.ms).toBe(100); // 100 - 0 (generation), not 110 - 0
  });
});

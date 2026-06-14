import { describe, expect, it } from 'vitest';
import {
  RunTraceCollector,
  assembleTimings,
  assemblePayloads,
  assembleTimeline,
  assembleTimelinePayloads,
  selectTurnTraceSlice,
  type GuardrailRecord,
  type LlmTurnRecord,
  type ToolCallRecord,
} from '@core/runtime/reply-trace.js';

function anyTool(): ToolCallRecord {
  return {
    server: 's',
    tool: 't',
    ms: 1,
    ok: true,
    startedAt: 0,
    requestBytes: 0,
    responseBytes: 0,
  };
}

describe('RunTraceCollector', () => {
  it('collects MCP calls per run, isolated across runs', () => {
    const c = new RunTraceCollector();
    c.recordTool('runA', {
      server: 'srv',
      tool: 'search',
      ms: 10,
      ok: true,
      startedAt: 1,
      requestBytes: 5,
      responseBytes: 9,
    });
    c.recordTool('runB', {
      server: 'crm',
      tool: 'open',
      ms: 7,
      ok: true,
      startedAt: 2,
      requestBytes: 1,
      responseBytes: 2,
    });
    expect(c.drain('runA').length).toBe(1);
    expect(c.drain('runA').length).toBe(0); // drained
    expect(c.drain('runB')[0].tool).toBe('open');
  });

  it('evicts stale runs beyond cap', () => {
    const c = new RunTraceCollector({ maxRuns: 2 });
    c.recordTool('r1', anyTool());
    c.recordTool('r2', anyTool());
    c.recordTool('r3', anyTool());
    expect(c.drain('r1').length).toBe(0); // evicted
    expect(c.drain('r2').length).toBe(1);
    expect(c.drain('r3').length).toBe(1);
  });

  it('drain of an unknown run returns empty, never throws', () => {
    const c = new RunTraceCollector();
    expect(c.drain('nope')).toEqual([]);
  });
});

describe('selectTurnTraceSlice', () => {
  const turn = (startedAt: number): LlmTurnRecord => ({
    ms: 1,
    startedAt,
    detail: {},
  });
  const guardrail: GuardrailRecord = {
    ms: 5,
    startedAt: 0,
    detail: { mode: 'deterministic', decision: 'allow', inlineAttached: true },
  };

  it('returns all turns plus the guardrail on the first traced turn', () => {
    const slice = selectTurnTraceSlice({
      allTurns: [turn(1), turn(2)],
      persistedTurnCount: 0,
      cursorId: 'm1',
      guardrail,
    });
    expect(slice).toEqual({
      llmTurns: [turn(1), turn(2)],
      guardrail,
      nextPersistedTurnCount: 2,
    });
  });

  it('slices only the new turns for a later warm-run turn, without the guardrail', () => {
    // A warm run emits the cumulative turn list each turn; only the tail beyond
    // persistedTurnCount belongs to this reply. The guardrail rode the 1st turn.
    const slice = selectTurnTraceSlice({
      allTurns: [turn(1), turn(2), turn(3)],
      persistedTurnCount: 2,
      cursorId: 'm2',
      lastPersistedCursorId: 'm1',
      guardrail,
    });
    expect(slice).toEqual({
      llmTurns: [turn(3)],
      nextPersistedTurnCount: 3,
    });
  });

  it('is idempotent per outbound message (same cursor → null)', () => {
    expect(
      selectTurnTraceSlice({
        allTurns: [turn(1), turn(2)],
        persistedTurnCount: 0,
        cursorId: 'm1',
        lastPersistedCursorId: 'm1',
        guardrail,
      }),
    ).toBeNull();
  });

  it('returns null when no new turns have accumulated', () => {
    expect(
      selectTurnTraceSlice({
        allTurns: [turn(1), turn(2)],
        persistedTurnCount: 2,
        cursorId: 'm2',
        lastPersistedCursorId: 'm1',
      }),
    ).toBeNull();
  });
});

describe('assembleTimings', () => {
  it('orders stages by startedAt and totals ms', () => {
    const t = assembleTimings({
      guardrail: {
        ms: 18,
        startedAt: 0,
        detail: {
          mode: 'deterministic',
          decision: 'allow',
          reason: 'inconclusive_inline_guardrail',
          inlineAttached: true,
        },
      },
      llmTurns: [
        {
          ms: 300,
          startedAt: 1,
          detail: {
            model: 'sonnet',
            stopReason: 'tool_use',
            tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 0 },
          },
        },
      ],
      toolCalls: [
        {
          server: 'srv',
          tool: 'search',
          ms: 21,
          ok: true,
          startedAt: 2,
          requestBytes: 5,
          responseBytes: 9,
        },
      ],
    });
    expect(t.stages.map((s) => s.kind)).toEqual(['guardrail', 'llm', 'tool']);
    expect(t.totalMs).toBe(18 + 300 + 21);
    expect(t.version).toBe(1);
  });

  it('interleaves llm and tool stages by start time', () => {
    const t = assembleTimings({
      guardrail: {
        ms: 5,
        startedAt: 0,
        detail: { mode: 'both', decision: 'allow', inlineAttached: false },
      },
      llmTurns: [
        { ms: 10, startedAt: 10, detail: {} },
        { ms: 10, startedAt: 40, detail: {} },
      ],
      toolCalls: [
        {
          server: 'srv',
          tool: 'a',
          ms: 5,
          ok: true,
          startedAt: 25,
          requestBytes: 0,
          responseBytes: 0,
        },
      ],
    });
    expect(t.stages.map((s) => s.kind)).toEqual([
      'guardrail',
      'llm',
      'tool',
      'llm',
    ]);
    // turn labels are assigned in turn order, not stage order
    const llmLabels = t.stages
      .filter((s) => s.kind === 'llm')
      .map((s) => s.label);
    expect(llmLabels).toEqual(['main LLM · turn 1', 'main LLM · turn 2']);
  });

  it('builds a command stage', () => {
    const t = assembleTimings({
      command: { name: '/new', ms: 4, startedAt: 0 },
    });
    expect(t.stages).toEqual([
      {
        kind: 'command',
        label: '/new',
        ms: 4,
        startedAt: 0,
        detail: { name: '/new' },
      },
    ]);
    expect(t.totalMs).toBe(4);
  });
});

describe('assembleTimeline (v2)', () => {
  const W0 = 1_000_000; // windowStart (ingress)
  it('partitions the window contiguously and sums to windowMs', () => {
    const t = assembleTimeline({
      windowStart: W0,
      windowEnd: W0 + 10_000,
      guardrail: {
        ms: 500,
        startedAt: W0 + 1_000,
        detail: {
          mode: 'deterministic',
          decision: 'allow',
          inlineAttached: false,
        },
      },
      startup: { startedAt: W0 + 1_500, readyAt: W0 + 3_000 },
      llmTurns: [
        { ms: 2_000, startedAt: W0 + 4_000, detail: { model: 'sonnet' } },
      ],
      send: { startedAt: W0 + 9_000, endedAt: W0 + 10_000 },
    });
    expect(t.version).toBe(2);
    expect(t.totalMs).toBe(10_000);
    expect(t.sections.reduce((s, x) => s + x.ms, 0)).toBe(10_000);
    // queue + guardrail + startup + model_wait + llm + (gap) + send present
    const kinds = t.sections.map((s) => s.kind);
    expect(kinds[0]).toBe('queue');
    expect(kinds).toContain('guardrail');
    expect(kinds).toContain('startup');
    expect(kinds).toContain('model_wait');
    expect(kinds).toContain('llm');
    expect(kinds).toContain('send');
  });

  it('labels the gap before an llm turn as model_wait and others as gap', () => {
    const t = assembleTimeline({
      windowStart: W0,
      windowEnd: W0 + 6_000,
      llmTurns: [
        { ms: 1_000, startedAt: W0 + 1_000, detail: {} },
        { ms: 1_000, startedAt: W0 + 4_000, detail: {} },
      ],
      toolCalls: [
        {
          server: 'shopify-api',
          tool: 'get_x',
          ms: 1_000,
          ok: true,
          startedAt: W0 + 2_000,
          requestBytes: 1,
          responseBytes: 1,
        },
      ],
    });
    const kinds = t.sections.map((s) => s.kind);
    expect(kinds).toContain('model_wait');
    expect(t.sections.reduce((s, x) => s + x.ms, 0)).toBe(6_000);
  });

  it('falls back to the span envelope when window anchors are missing', () => {
    const t = assembleTimeline({
      llmTurns: [{ ms: 2_000, startedAt: W0 + 1_000, detail: {} }],
    });
    expect(t.windowStart).toBe(W0 + 1_000);
    expect(t.windowEnd).toBe(W0 + 3_000);
    expect(t.totalMs).toBe(2_000);
    expect(t.sections.reduce((s, x) => s + x.ms, 0)).toBe(2_000);
  });

  it('clamps overlaps so sections never exceed the window', () => {
    const t = assembleTimeline({
      windowStart: W0,
      windowEnd: W0 + 3_000,
      toolCalls: [
        {
          server: 's',
          tool: 't',
          ms: 9_999,
          ok: true,
          startedAt: W0 + 1_000,
          requestBytes: 0,
          responseBytes: 0,
        },
      ],
    });
    expect(t.totalMs).toBe(3_000);
    expect(t.sections.reduce((s, x) => s + x.ms, 0)).toBe(3_000);
    expect(t.sections.every((s) => s.ms >= 0)).toBe(true);
  });

  it('handles empty input without throwing', () => {
    const t = assembleTimeline({});
    expect(t.version).toBe(2);
    expect(t.totalMs).toBe(0);
    expect(t.sections).toEqual([]);
  });

  it('produces no sections for a zero-length window', () => {
    const t = assembleTimeline({
      windowStart: 1_000_000,
      windowEnd: 1_000_000,
    });
    expect(t.totalMs).toBe(0);
    expect(t.sections).toEqual([]);
  });

  it('aligns payloads to the output section index for llm/tool sections', () => {
    const input = {
      windowStart: W0,
      windowEnd: W0 + 5_000,
      llmTurns: [
        {
          ms: 1_000,
          startedAt: W0 + 1_000,
          detail: {},
          input: 'hi',
          output: 'yo',
        },
      ],
      toolCalls: [
        {
          server: 's',
          tool: 't',
          ms: 1_000,
          ok: true,
          startedAt: W0 + 3_000,
          requestBytes: 0,
          responseBytes: 0,
          request: { a: 1 },
          response: { b: 2 },
        },
      ],
    };
    const t = assembleTimeline(input);
    const p = assembleTimelinePayloads(input);
    const llmIdx = t.sections.findIndex((s) => s.kind === 'llm');
    const toolIdx = t.sections.findIndex((s) => s.kind === 'tool');
    expect(p[llmIdx]).toEqual({ input: 'hi', output: 'yo' });
    expect(p[toolIdx]).toEqual({ request: { a: 1 }, response: { b: 2 } });
  });
});

describe('assemblePayloads', () => {
  it('keys payloads by stage index for tool and llm stages', () => {
    const input = {
      guardrail: {
        ms: 5,
        startedAt: 0,
        detail: { mode: 'both', decision: 'allow', inlineAttached: false },
      },
      llmTurns: [
        {
          ms: 10,
          startedAt: 1,
          detail: {},
          input: 'turn input',
          output: 'turn output',
        },
      ],
      toolCalls: [
        {
          server: 'srv',
          tool: 'a',
          ms: 5,
          ok: true,
          startedAt: 2,
          requestBytes: 0,
          responseBytes: 0,
          request: { q: 1 },
          response: { r: 2 },
        },
      ],
    };
    // Indices line up because assemblePayloads and assembleTimings build the
    // same ordered stage list from the same input.
    const timings = assembleTimings(input);
    expect(timings.stages.map((s) => s.kind)).toEqual([
      'guardrail',
      'llm',
      'tool',
    ]);
    const payloads = assemblePayloads(input);
    // stage 0 = guardrail (no payload), 1 = llm, 2 = tool
    expect(payloads[1]).toMatchObject({
      input: 'turn input',
      output: 'turn output',
    });
    expect(payloads[2]).toEqual({ request: { q: 1 }, response: { r: 2 } });
    expect(payloads[0]).toBeUndefined();
  });
});

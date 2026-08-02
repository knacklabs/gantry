import { describe, expect, it } from 'vitest';

import {
  RESPONSE_LATENCY_BOUNDARIES,
  RESPONSE_LATENCY_OPERATION_NAMES,
  createBoundaryDelayInjector,
  createDeterministicBarrier,
  createManualClock,
  createOperationCounter,
  createResponseLatencyHarness,
  createScriptedFakeStreamingModel,
  isContentBearingFrame,
  type ResponseLatencyFrame,
} from '../../harness/response-latency-harness.js';

describe('response latency harness contract', () => {
  it('records deterministic clock markers and advances only under test control', () => {
    const clock = createManualClock(100);

    expect(clock.mark('ingress_received')).toEqual({
      name: 'ingress_received',
      atMs: 100,
    });
    expect(clock.advanceMs(25)).toBe(125);
    expect(clock.mark('provider_first_byte')).toEqual({
      name: 'provider_first_byte',
      atMs: 125,
    });
    expect(clock.markers()).toEqual([
      { name: 'ingress_received', atMs: 100 },
      { name: 'provider_first_byte', atMs: 125 },
    ]);
    expect(() => clock.advanceMs(-1)).toThrow(/non-negative/);
  });

  it('counts every named operation plus phase-local additions', () => {
    const operations = createOperationCounter();

    RESPONSE_LATENCY_OPERATION_NAMES.forEach((name, index) => {
      operations.increment(name, index + 1);
    });
    operations.increment('phase_local_calls', 2);
    const snapshot = operations.snapshot();
    operations.increment('phase_local_calls');

    expect(snapshot).toEqual({
      postgres_statements: 1,
      postgres_transactions: 2,
      get_messages_since_calls: 3,
      provider_history_calls: 4,
      memory_hydrate_calls: 5,
      list_enabled_skills_calls: 6,
      get_skill_calls: 7,
      list_tool_bindings_calls: 8,
      get_tool_calls: 9,
      list_mcp_bindings_calls: 10,
      get_mcp_server_calls: 11,
      s3_list_calls: 12,
      s3_get_calls: 13,
      mcp_connect_calls: 14,
      mcp_list_tools_calls: 15,
      phase_local_calls: 2,
    });
    expect(operations.get('phase_local_calls')).toBe(3);
    expect(operations.get('unobserved_calls')).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('injects every named boundary delay under manual-clock control', async () => {
    const clock = createManualClock(20);
    const delays = createBoundaryDelayInjector({ clock });

    RESPONSE_LATENCY_BOUNDARIES.forEach((boundary, index) => {
      delays.setDelayMs(boundary, index);
    });
    for (const boundary of RESPONSE_LATENCY_BOUNDARIES) {
      await delays.wait(boundary);
    }

    expect(clock.nowMs()).toBe(210);
    expect(delays.snapshot()).toEqual(
      Object.fromEntries(
        RESPONSE_LATENCY_BOUNDARIES.map((boundary, index) => [boundary, index]),
      ),
    );
  });

  it('rejects invalid clock, counter, and delay values', () => {
    const clock = createManualClock();
    const operations = createOperationCounter();
    const delays = createBoundaryDelayInjector({ clock });

    for (const startMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => createManualClock(startMs)).toThrow(/start must be finite/);
    }
    expect(() => clock.advanceMs(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => operations.increment('memory_hydrate_calls', 0.5)).toThrow(
      /integer/,
    );
    expect(() => delays.setDelayMs('provider_first_byte', Number.NaN)).toThrow(
      /finite/,
    );
  });

  it('rejects manual-clock overflow without mutating its timestamp', () => {
    const clock = createManualClock(Number.MAX_VALUE);

    expect(() => clock.advanceMs(Number.MAX_VALUE)).toThrow(
      /result must be finite/,
    );
    expect(clock.nowMs()).toBe(Number.MAX_VALUE);
  });

  it('excludes init, control, terminal, empty, and whitespace frames from content', () => {
    const nonContentFrames: ResponseLatencyFrame[] = [
      { kind: 'session_init', sessionCreated: true },
      { kind: 'runtime_event', eventType: 'run.startup_diagnostic' },
      { kind: 'progress', status: 'working' },
      { kind: 'typing', active: true },
      { kind: 'usage', inputTokens: 10, outputTokens: 0 },
      { kind: 'terminal', result: null },
      { kind: 'terminal', result: 'completed' },
      { kind: 'terminal', result: 'failed' },
      { kind: 'content_part', text: '' },
      { kind: 'content_chunk', text: '   ' },
      { kind: 'content_part', text: '\u200b\u200d\u200f' },
      { kind: 'content_chunk', text: '\0\ufe0f' },
    ];

    expect(
      nonContentFrames.every((frame) => !isContentBearingFrame(frame)),
    ).toBe(true);
    expect(
      isContentBearingFrame({ kind: 'content_part', text: ' answer ' }),
    ).toBe(true);
    expect(
      isContentBearingFrame({ kind: 'content_chunk', text: '\nanswer\n' }),
    ).toBe(true);
    expect(isContentBearingFrame({ kind: 'content_chunk', text: '👩‍💻' })).toBe(
      true,
    );
  });

  it('emits scripted control frames before delayed fake-model content', async () => {
    const clock = createManualClock(10);
    const frames: ResponseLatencyFrame[] = [];
    const model = createScriptedFakeStreamingModel({
      preContentFrames: [
        { kind: 'session_init', sessionCreated: true },
        { kind: 'progress', status: 'thinking' },
      ],
      contentFrame: { kind: 'content_chunk', text: 'ready' },
      delay: () => {
        clock.advanceMs(40);
      },
    });

    await model.stream((frame) => {
      frames.push(frame);
    });

    expect(frames.map((frame) => frame.kind)).toEqual([
      'session_init',
      'progress',
      'content_chunk',
    ]);
    expect(clock.nowMs()).toBe(50);
  });

  it('rejects fake-model scripts that blur the pre-content boundary', () => {
    expect(() =>
      createScriptedFakeStreamingModel({
        preContentFrames: [{ kind: 'content_part', text: 'too early' }],
        contentFrame: { kind: 'content_chunk', text: 'ready' },
        delay: () => undefined,
      }),
    ).toThrow(/pre-content frames must be non-content/);
    expect(() =>
      createScriptedFakeStreamingModel({
        contentFrame: { kind: 'terminal', result: null },
        delay: () => undefined,
      }),
    ).toThrow(/requires one content-bearing frame/);
  });

  it('publishes a completed send from its original visibility candidate', () => {
    const harness = createResponseLatencyHarness({ startMs: 100 });
    const attempt = harness.channel.beginAttempt('completed');
    attempt.observe(
      { kind: 'progress', status: 'working' },
      { delivered: true },
    );
    harness.clock.advanceMs(20);
    attempt.observe(
      { kind: 'content_chunk', text: 'first content' },
      { delivered: true },
    );
    harness.clock.advanceMs(80);
    attempt.settle('completed');

    expect(harness.channel.firstContentAtMs()).toBe(120);
    expect(attempt.snapshot()).toMatchObject({
      settlement: 'completed',
      candidateAtMs: 120,
      publishedAtMs: 120,
    });
  });

  it('publishes delivery_incomplete only with delivered content proof', () => {
    const qualifying = createResponseLatencyHarness({ startMs: 200 });
    const qualifyingAttempt =
      qualifying.channel.beginAttempt('partial-content');
    qualifyingAttempt.observe(
      { kind: 'content_part', text: 'visible part' },
      { delivered: true },
    );
    qualifyingAttempt.settle('delivery_incomplete');

    const controlOnly = createResponseLatencyHarness({ startMs: 300 });
    const controlAttempt = controlOnly.channel.beginAttempt('partial-control');
    controlAttempt.observe(
      { kind: 'progress', status: 'working' },
      { delivered: true },
    );
    controlAttempt.observe(
      { kind: 'content_part', text: 'failed part' },
      { delivered: false },
    );
    controlAttempt.settle('delivery_incomplete');

    expect(qualifying.channel.firstContentAtMs()).toBe(200);
    expect(qualifyingAttempt.snapshot().publishedAtMs).toBe(200);
    expect(controlOnly.channel.firstContentAtMs()).toBeUndefined();
    expect(controlAttempt.snapshot()).not.toHaveProperty('publishedAtMs');
  });

  it('discards candidates for failed and rejected delivery attempts', () => {
    const harness = createResponseLatencyHarness({ startMs: 400 });
    const failed = harness.channel.beginAttempt('failed');
    failed.observe(
      { kind: 'content_chunk', text: 'candidate' },
      { delivered: true },
    );
    failed.settle('not_delivered');

    harness.clock.advanceMs(10);
    const rejected = harness.channel.beginAttempt('rejected');
    rejected.observe(
      { kind: 'content_chunk', text: 'candidate' },
      { delivered: true },
    );
    rejected.reject();

    expect(harness.channel.firstContentAtMs()).toBeUndefined();
    expect(failed.snapshot()).not.toHaveProperty('publishedAtMs');
    expect(rejected.snapshot()).not.toHaveProperty('publishedAtMs');
    expect(
      harness.channel.attempts().map((attempt) => attempt.settlement),
    ).toEqual(['not_delivered', 'rejected']);
  });

  it('keeps the earliest qualifying timestamp across retries and settlement order', () => {
    const harness = createResponseLatencyHarness({ startMs: 100 });
    const first = harness.channel.beginAttempt('first');
    first.observe(
      { kind: 'content_chunk', text: 'earliest candidate' },
      { delivered: true },
    );

    harness.clock.advanceMs(100);
    const retry = harness.channel.beginAttempt('retry');
    retry.observe(
      { kind: 'content_chunk', text: 'later candidate' },
      { delivered: true },
    );
    retry.settle('completed');
    expect(harness.channel.firstContentAtMs()).toBe(200);

    first.settle('delivery_incomplete');
    expect(harness.channel.firstContentAtMs()).toBe(100);

    harness.clock.advanceMs(100);
    const fallback = harness.channel.beginAttempt('fallback');
    fallback.observe(
      { kind: 'content_chunk', text: 'latest candidate' },
      { delivered: true },
    );
    fallback.settle('completed');
    expect(harness.channel.firstContentAtMs()).toBe(100);
  });

  it('records only sanitized delivery status, timing, and boolean evidence', () => {
    const harness = createResponseLatencyHarness();
    const attempt = harness.channel.beginAttempt('sanitized-attempt');
    attempt.observe(
      { kind: 'content_chunk', text: 'secret message content' },
      { delivered: true },
    );
    attempt.settle('completed');

    expect(attempt.snapshot()).toEqual({
      id: 'sanitized-attempt',
      settlement: 'completed',
      frames: [
        {
          kind: 'content_chunk',
          contentBearing: true,
          delivered: true,
        },
      ],
      candidateAtMs: 0,
      publishedAtMs: 0,
    });
    expect(JSON.stringify(harness.channel.attempts())).not.toContain(
      'secret message content',
    );
  });

  it('refuses observations or repeated settlement after an attempt ends', () => {
    const harness = createResponseLatencyHarness();
    const attempt = harness.channel.beginAttempt('one-shot');
    attempt.settle('not_delivered');

    expect(() =>
      attempt.observe(
        { kind: 'content_chunk', text: 'too late' },
        { delivered: true },
      ),
    ).toThrow(/already settled/);
    expect(() => attempt.settle('completed')).toThrow(/already settled/);
  });

  it('proves five operations begin through a four-active bound', async () => {
    const barrier = createDeterministicBarrier(5);
    const pending = [0, 1, 2, 3, 4];
    const participants: ReturnType<typeof barrier.arrive>[] = [];
    let resolveDrained: (() => void) | undefined;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    const beginNext = () => {
      if (pending.shift() === undefined) return;
      const participant = barrier.arrive();
      participants.push(participant);
      void participant.completed.then(() => {
        beginNext();
        if (barrier.snapshot().completed === 5) resolveDrained?.();
      });
    };
    Array.from({ length: 4 }).forEach(beginNext);

    await barrier.waitForArrivals(4);
    expect(barrier.snapshot()).toEqual({
      arrivals: 4,
      active: 4,
      completed: 0,
      maximumActive: 4,
      allArrived: false,
    });

    participants[0]?.release();
    await participants[0]?.completed;
    await barrier.waitForAll();
    expect(barrier.snapshot()).toEqual({
      arrivals: 5,
      active: 4,
      completed: 1,
      maximumActive: 4,
      allArrived: true,
    });

    participants.slice(1).forEach((participant) => participant.release());
    await drained;
    expect(barrier.snapshot()).toEqual({
      arrivals: 5,
      active: 0,
      completed: 5,
      maximumActive: 4,
      allArrived: true,
    });
  });

  it('detects an unbounded caller exceeding a four-operation cap', async () => {
    const barrier = createDeterministicBarrier(5);
    const participants = Array.from({ length: 5 }, () => barrier.arrive());

    await barrier.waitForAll();
    expect(barrier.snapshot().maximumActive).toBe(5);
    participants.forEach((participant) => participant.release());
    await Promise.all(participants.map((participant) => participant.completed));
    expect(barrier.snapshot().active).toBe(0);
  });

  it('rejects invalid barrier sizes, waits, and excess arrivals', () => {
    expect(() => createDeterministicBarrier(0)).toThrow(/positive integer/);
    const barrier = createDeterministicBarrier(1);
    expect(() => barrier.waitForArrivals(2)).toThrow(/expected arrivals/);
    const participant = barrier.arrive();
    expect(() => barrier.arrive()).toThrow(/more arrivals/);
    participant.release();
    participant.release();
    expect(barrier.snapshot().completed).toBe(1);
  });

  it('isolates all mutable primitive state across ten harness instances', async () => {
    const harnesses = Array.from({ length: 10 }, (_, index) =>
      createResponseLatencyHarness({ startMs: index * 100 }),
    );
    const barriers = harnesses.map((harness) => harness.createBarrier(1));
    const participants = barriers.map((barrier) => barrier.arrive());
    await Promise.all(barriers.map((barrier) => barrier.waitForAll()));

    for (const [index, harness] of harnesses.entries()) {
      harness.clock.advanceMs(index);
      harness.clock.mark(`marker_${index}`);
      harness.operations.increment(`operation_${index}`, index + 1);
      harness.delays.setDelayMs('provider_first_byte', index);
      await harness.delays.wait('provider_first_byte');
      const attempt = harness.channel.beginAttempt(`attempt_${index}`);
      attempt.observe(
        { kind: 'content_part', text: `content ${index}` },
        { delivered: true },
      );
      attempt.settle('completed');
    }

    participants[0]?.release();
    await participants[0]?.completed;
    expect(barriers[0]?.snapshot().active).toBe(0);
    expect(
      barriers.slice(1).every((barrier) => barrier.snapshot().active === 1),
    ).toBe(true);
    participants.slice(1).forEach((participant) => participant.release());
    await Promise.all(
      participants.slice(1).map((participant) => participant.completed),
    );

    harnesses.forEach((harness, index) => {
      expect(harness.clock.nowMs()).toBe(index * 102);
      expect(harness.clock.markers()).toEqual([
        { name: `marker_${index}`, atMs: index * 101 },
      ]);
      expect(harness.operations.get(`operation_${index}`)).toBe(index + 1);
      expect(
        harnesses.every(
          (other, otherIndex) =>
            otherIndex === index ||
            other.operations.get(`operation_${index}`) === 0,
        ),
      ).toBe(true);
      expect(harness.delays.snapshot().provider_first_byte).toBe(index);
      expect(harness.channel.attempts()).toHaveLength(1);
      expect(harness.channel.firstContentAtMs()).toBe(index * 102);
    });
  });
});

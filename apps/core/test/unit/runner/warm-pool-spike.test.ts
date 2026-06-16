import { afterEach, describe, expect, it } from 'vitest';

import { assembleTimeline } from '@core/runtime/reply-trace.js';
import {
  baseInput,
  createRunnerFixture,
  readRecord,
  readRunnerOutputs,
  registerRunnerFixtureCleanup,
  runRunner,
} from './agent-runner-ipc.test-helpers.js';

registerRunnerFixtureCleanup(afterEach);

const SPIKE_TIMEOUT_MS = 35_000;

interface ReplyEnvelope {
  dispatchedAt?: number;
  runnerStartup?: unknown;
  turns?: Array<{
    ms: number;
    startedAt: number;
    detail: {
      tokens?: {
        in: number;
        out: number;
        cacheRead: number;
        cacheWrite: number;
      };
    };
  }>;
}

describe('warm-pool spike: SDK warm primitive', () => {
  it(
    'boots via startup() and serves one query() with no re-spawn (F10)',
    async () => {
      const fx = createRunnerFixture();
      // GANTRY_WARM_POOL_BOOT=generic makes the runner take the startup() path
      // (Task 1.2). The bind is delivered via GANTRY_SPIKE_BIND (test-only fast
      // path; production uses the IPC bind channel).
      await runRunner(fx, baseInput({ warmGenericBoot: true }), {
        GANTRY_WARM_POOL: '1',
        // A deliberate 2nd warm.query() (test-only hook) proves the SDK's
        // single-use guard fires; production binds exactly once per worker.
        GANTRY_SPIKE_DOUBLE_QUERY: '1',
        GANTRY_SPIKE_BIND: JSON.stringify({
          chatJid: 'wa:111',
          firstMessage: 'do you have kaju katli?',
          memoryBlock: '',
        }),
      });
      const rec = readRecord(fx.recordPath);
      expect(rec.startupCalls).toBe(1); // startup() invoked once
      expect(rec.calls.length).toBe(1); // exactly one query() = no re-spawn
      expect(rec.warmQueryDoubleCallThrew).toBe(true); // single-use enforced
    },
    SPIKE_TIMEOUT_MS,
  );

  it(
    'delivers first message + context at bind, not at boot (F3)',
    async () => {
      const fx = createRunnerFixture();
      await runRunner(fx, baseInput({ warmGenericBoot: true }), {
        GANTRY_WARM_POOL: '1',
        GANTRY_SPIKE_BIND: JSON.stringify({
          chatJid: 'wa:111',
          firstMessage: 'do you have kaju katli?',
          memoryBlock: 'MEM-111',
        }),
      });
      const rec = readRecord(fx.recordPath);
      const call = rec.calls[0];
      expect(call?.promptKind).toBe('stream');
      const text = JSON.stringify(call?.streamMessages);
      expect(text).toContain('do you have kaju katli?'); // bound first message rode the stream
      expect(text).toContain('MEM-111'); // memory block rode the stream
      expect(call?.systemPromptAppend ?? '').not.toContain('wa:111'); // identity NOT in boot prompt
    },
    SPIKE_TIMEOUT_MS,
  );

  it(
    'warm-bound first reply emits dispatchedAt and no runnerStartup (F1)',
    async () => {
      const fx = createRunnerFixture();
      const { stdout } = await runRunner(
        fx,
        baseInput({ warmGenericBoot: true }),
        {
          GANTRY_WARM_POOL: '1',
          GANTRY_SPIKE_BIND: JSON.stringify({
            chatJid: 'wa:111',
            firstMessage: 'hi',
            memoryBlock: '',
          }),
        },
      );
      const outputs = readRunnerOutputs(stdout);
      // The reply envelope is the one carrying the warm dispatch mark. A warm
      // worker's firstSdkMessageAt predates bind, so runnerStartup would
      // mis-route the trace; it must be suppressed in favor of dispatchedAt.
      const reply = outputs.find((o) => o.dispatchedAt !== undefined);
      expect(reply, JSON.stringify(outputs)).toBeDefined();
      expect(reply?.warmBound).toBe(true);
      expect(reply?.dispatchedAt as number).toBeGreaterThan(0);
      expect(reply?.runnerStartup).toBeUndefined();
      // No envelope anywhere should carry runnerStartup for a warm-bound run.
      expect(
        outputs.some((o) => o.runnerStartup !== undefined),
        JSON.stringify(outputs),
      ).toBe(false);
    },
    SPIKE_TIMEOUT_MS,
  );

  // THE GATE (§9). Consolidated end-to-end proof on the real runner + fake SDK.
  it(
    'gate: generic boot → bind → reply with no re-spawn, no startup span, clean warm split, cache plumbing, single-use',
    async () => {
      const fx = createRunnerFixture();
      const { stdout } = await runRunner(
        fx,
        baseInput({ warmGenericBoot: true }),
        {
          GANTRY_WARM_POOL: '1',
          // Bind: first message + per-customer memory delivered at runtime.
          GANTRY_SPIKE_BIND: JSON.stringify({
            chatJid: 'wa:919812345678',
            firstMessage: 'do you have kaju katli in stock?',
            memoryBlock: 'MEM-customer-2',
          }),
          // Sample usage so the cache-token plumbing can be asserted (criterion
          // 4 is PLUMBING only — see the comment on the assertion below).
          GANTRY_SPIKE_USAGE: JSON.stringify({
            in: 6500,
            out: 80,
            cacheRead: 6384,
            cacheWrite: 0,
          }),
          // Prove the WarmQuery single-use guard fires (criterion 5 / F10).
          GANTRY_SPIKE_DOUBLE_QUERY: '1',
        },
      );

      const rec = readRecord(fx.recordPath);
      const outputs = readRunnerOutputs(stdout) as ReplyEnvelope[];

      // --- Criterion 1: NO re-spawn. One startup() + exactly one query(); the
      // first message + context rode the stream, not the boot system prompt. ---
      expect(rec.startupCalls).toBe(1);
      expect(rec.calls.length).toBe(1);
      const call = rec.calls[0];
      expect(call?.promptKind).toBe('stream');
      const streamText = JSON.stringify(call?.streamMessages);
      expect(streamText).toContain('do you have kaju katli in stock?');
      expect(streamText).toContain('MEM-customer-2');
      expect(call?.systemPromptAppend ?? '').not.toContain('wa:919812345678');
      expect(call?.systemPromptAppend ?? '').not.toContain('MEM-customer-2');

      // --- Criterion 5: WarmQuery single-use enforced (F10). ---
      expect(rec.warmQueryDoubleCallThrew).toBe(true);

      // --- Criterion 2: NO `startup` span + clean warm split. The reply emits
      // dispatchedAt (not runnerStartup); feeding it into assembleTimeline (the
      // same assembler core uses) yields a leading queue + model_wait with NO
      // startup, exactly like reply-trace.test.ts's warm-continuation case. ---
      const reply = outputs.find((o) => o.dispatchedAt !== undefined);
      expect(reply, JSON.stringify(outputs)).toBeDefined();
      expect(reply?.warmBound).toBe(true);
      expect(reply?.runnerStartup).toBeUndefined();
      const dispatchedAt = reply!.dispatchedAt!;
      const windowStart = dispatchedAt - 300; // ingress 300ms before dispatch
      const timeline = assembleTimeline({
        windowStart,
        windowEnd: dispatchedAt + 5000,
        dispatchedAt,
        llmTurns: [{ ms: 2000, startedAt: dispatchedAt + 1900, detail: {} }],
        send: { startedAt: dispatchedAt + 4990, endedAt: dispatchedAt + 5000 },
      });
      expect(timeline.sections.map((s) => s.kind)).toEqual([
        'queue',
        'model_wait',
        'llm',
        'gap',
        'send',
      ]);
      expect(timeline.sections.some((s) => s.kind === 'startup')).toBe(false);
      expect(timeline.sections.reduce((a, s) => a + s.ms, 0)).toBe(
        timeline.totalMs,
      );

      // --- Criterion 4: CACHE PLUMBING ONLY. The cache-token fields are carried
      // through the reply envelope on `turns[].detail.tokens.cacheRead/cacheWrite`
      // (the exact field the reply trace consumes; LlmTurnRecord.detail.tokens).
      // We assert the PLUMBING (the sample values flow end-to-end), NOT that the
      // cache was actually warm. Real warmth (cacheRead>0 && cacheWrite===0 on
      // customer 2) is an E2E measurement (Phase 4 / measure-latency) — do NOT
      // fake a positive here. ---
      const turnTokens = reply!.turns?.[0]?.detail.tokens;
      expect(turnTokens, JSON.stringify(reply)).toBeDefined();
      expect(turnTokens).toEqual({
        in: 6500,
        out: 80,
        cacheRead: 6384,
        cacheWrite: 0,
      });
    },
    SPIKE_TIMEOUT_MS,
  );
});

import { describe, expect, it } from 'vitest';

import { createDeferredContextUsageEmitter } from '@core/adapters/llm/anthropic-claude-agent/runner/context-usage-emitter.js';
import type { AgentRunnerOutput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';

const SNAPSHOT = {
  totalTokens: 30_000,
  maxTokens: 200_000,
  percentage: 15,
  categories: [],
  at: '2026-06-10T18:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createDeferredContextUsageEmitter', () => {
  it('emits a result-less envelope carrying contextUsage once the fetch resolves', async () => {
    const written: AgentRunnerOutput[] = [];
    const fetch = deferred<typeof SNAPSHOT | undefined>();
    const emitter = createDeferredContextUsageEmitter({
      readUsage: () => fetch.promise,
      write: (output) => written.push(output),
      getSessionId: () => 'session-1',
    });

    emitter.emitAfterResult();
    // The reply envelope is NOT blocked: nothing has been written yet and the
    // caller has already moved on.
    expect(written).toEqual([]);

    fetch.resolve(SNAPSHOT);
    await emitter.flush(1_000);

    expect(written).toEqual([
      {
        status: 'success',
        result: null,
        newSessionId: 'session-1',
        contextUsage: SNAPSHOT,
      },
    ]);
  });

  it('writes nothing when context usage is unavailable', async () => {
    const written: AgentRunnerOutput[] = [];
    const emitter = createDeferredContextUsageEmitter({
      readUsage: () => Promise.resolve(undefined),
      write: (output) => written.push(output),
      getSessionId: () => undefined,
    });
    emitter.emitAfterResult();
    await emitter.flush(1_000);
    expect(written).toEqual([]);
  });

  it('serializes fetches across results instead of overlapping them', async () => {
    const written: AgentRunnerOutput[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = [deferred<typeof SNAPSHOT>(), deferred<typeof SNAPSHOT>()];
    let calls = 0;
    const emitter = createDeferredContextUsageEmitter({
      readUsage: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = gates[calls++];
        return gate.promise.then((value) => {
          inFlight -= 1;
          return value;
        });
      },
      write: (output) => written.push(output),
      getSessionId: () => 'session-1',
    });

    emitter.emitAfterResult();
    emitter.emitAfterResult();
    gates[0].resolve({ ...SNAPSHOT, totalTokens: 1 });
    gates[1].resolve({ ...SNAPSHOT, totalTokens: 2 });
    await emitter.flush(1_000);

    expect(maxInFlight).toBe(1);
    expect(written.map((w) => w.contextUsage?.totalTokens)).toEqual([1, 2]);
  });

  it('swallows fetch rejections without breaking later emissions', async () => {
    const written: AgentRunnerOutput[] = [];
    let calls = 0;
    const emitter = createDeferredContextUsageEmitter({
      readUsage: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('cli went away'))
          : Promise.resolve(SNAPSHOT);
      },
      write: (output) => written.push(output),
      getSessionId: () => 'session-1',
    });
    emitter.emitAfterResult();
    emitter.emitAfterResult();
    await emitter.flush(1_000);
    expect(written).toHaveLength(1);
    expect(written[0]?.contextUsage).toEqual(SNAPSHOT);
  });

  it('flush resolves within its bound even when a fetch hangs', async () => {
    const emitter = createDeferredContextUsageEmitter({
      readUsage: () => new Promise(() => {}), // never resolves
      write: () => {},
      getSessionId: () => undefined,
    });
    emitter.emitAfterResult();
    const started = Date.now();
    await emitter.flush(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

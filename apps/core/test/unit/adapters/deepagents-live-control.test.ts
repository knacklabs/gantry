import fs from 'node:fs';
import type { FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAbortError,
  startDeepAgentLiveControl,
} from '@core/adapters/llm/deepagents-langchain/runner/live-control.js';

// The live-control loop watches the neutral IPC-input dir (GANTRY_IPC_INPUT_DIR)
// that the host writes follow-ups and the `_close` sentinel into, exactly like
// the Anthropic runner's in-query polling. These tests drive that dir directly.

let ipcDir: string;
let priorIpcDir: string | undefined;

beforeEach(() => {
  ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagents-live-control-'));
  priorIpcDir = process.env.GANTRY_IPC_INPUT_DIR;
  process.env.GANTRY_IPC_INPUT_DIR = ipcDir;
});

afterEach(() => {
  if (priorIpcDir === undefined) delete process.env.GANTRY_IPC_INPUT_DIR;
  else process.env.GANTRY_IPC_INPUT_DIR = priorIpcDir;
  fs.rmSync(ipcDir, { recursive: true, force: true });
});

function writeMessage(text: string, seq: number): void {
  const file = path.join(ipcDir, `${Date.now()}-${seq}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', text }));
}

function writeCloseSentinel(): void {
  fs.writeFileSync(path.join(ipcDir, '_close'), '');
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

function fakeWatcher(): FSWatcher {
  return {
    close: vi.fn(),
    on: vi.fn(),
    unref: vi.fn(),
  } as unknown as FSWatcher;
}

function timeoutDeps() {
  const timers: Array<{ callback: () => void; ms: number; handle: unknown }> =
    [];
  const setTimeoutFn = vi.fn((callback: () => void, ms: number) => {
    const handle = { unref: vi.fn() };
    timers.push({ callback, ms, handle });
    return handle as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutFn = vi.fn();
  return { timers, setTimeoutFn, clearTimeoutFn };
}

describe('startDeepAgentLiveControl (STOP / close-stdin)', () => {
  it('aborts the in-flight stream and marks closed when a _close sentinel appears', async () => {
    const control = startDeepAgentLiveControl({ pollMs: 10 });
    expect(control.signal.aborted).toBe(false);
    expect(control.closed()).toBe(false);

    writeCloseSentinel();

    await waitFor(() => control.signal.aborted);
    expect(control.closed()).toBe(true);
    expect(control.signal.aborted).toBe(true);
    control.stop();
  });

  it('buffers mid-stream follow-up messages in arrival order', async () => {
    const control = startDeepAgentLiveControl({ pollMs: 10 });
    writeMessage('first follow-up', 1);
    writeMessage('second follow-up', 2);

    await waitFor(() => control.takeBufferedFollowups.length >= 0);
    // poll a couple cycles to let the loop drain both files
    await new Promise((resolve) => setTimeout(resolve, 40));
    const drained = control.takeBufferedFollowups();
    expect(drained).toEqual(['first follow-up', 'second follow-up']);
    // Second read returns nothing (drain semantics).
    expect(control.takeBufferedFollowups()).toEqual([]);
    control.stop();
  });

  it('stop() halts polling so a later sentinel does not abort', async () => {
    const control = startDeepAgentLiveControl({ pollMs: 10 });
    control.stop();
    writeCloseSentinel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(control.signal.aborted).toBe(false);
    expect(control.closed()).toBe(false);
  });

  it('drainNow() folds a follow-up written after the last poll into the buffer (R4)', () => {
    // A very long poll interval so the timer never ticks during the test: the
    // only drain is the synchronous drainNow() the loop runs before deciding to
    // break. A follow-up landing in that window must not be orphaned.
    const control = startDeepAgentLiveControl({ pollMs: 1_000_000 });
    writeMessage('late follow-up', 1);
    // Without a poll tick the buffer is empty...
    expect(control.takeBufferedFollowups()).toEqual([]);
    // ...until the synchronous final drain folds it in.
    control.drainNow();
    expect(control.takeBufferedFollowups()).toEqual(['late follow-up']);
    control.stop();
  });

  it('drainNow() observes a _close that landed after the last poll (R5)', () => {
    const control = startDeepAgentLiveControl({ pollMs: 1_000_000 });
    writeCloseSentinel();
    expect(control.closed()).toBe(false);
    control.drainNow();
    expect(control.closed()).toBe(true);
    expect(control.signal.aborted).toBe(true);
    control.stop();
  });

  it('drainNow() is safe to call after stop() and does not reschedule', () => {
    const control = startDeepAgentLiveControl({ pollMs: 10 });
    control.stop();
    writeMessage('after stop', 1);
    control.drainNow();
    expect(control.takeBufferedFollowups()).toEqual(['after stop']);
  });

  it('wakes from fs.watch events without waiting for the fallback poll', () => {
    const timeouts = timeoutDeps();
    const listeners = new Map<string, WatchListener>();
    const control = startDeepAgentLiveControl({
      pollMs: 1_000_000,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn((dir, _options, listener) => {
          listeners.set(dir, listener);
          return fakeWatcher();
        }),
      },
    });

    expect(timeouts.timers.map((timer) => timer.ms)).toEqual([1_000_000]);
    writeMessage('watched follow-up', 1);
    listeners.get(ipcDir)?.('rename', 'message-1.json');
    expect(timeouts.timers.at(-1)?.ms).toBe(0);
    timeouts.timers.at(-1)?.callback();

    expect(control.takeBufferedFollowups()).toEqual(['watched follow-up']);
    control.stop();
  });

  it('wakes and aborts from a watched _close sentinel', () => {
    const timeouts = timeoutDeps();
    const listeners = new Map<string, WatchListener>();
    const control = startDeepAgentLiveControl({
      pollMs: 1_000_000,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn((dir, _options, listener) => {
          listeners.set(dir, listener);
          return fakeWatcher();
        }),
      },
    });

    writeCloseSentinel();
    listeners.get(ipcDir)?.('rename', '_close');
    expect(timeouts.timers.at(-1)?.ms).toBe(0);
    timeouts.timers.at(-1)?.callback();

    expect(control.closed()).toBe(true);
    expect(control.signal.aborted).toBe(true);
    control.stop();
  });
});

describe('isAbortError', () => {
  it('recognizes AbortError and abort-message errors', () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(new Error('Aborted by signal'))).toBe(true);
  });

  it('does not treat unrelated errors as aborts', () => {
    expect(isAbortError(new Error('model gateway 500'))).toBe(false);
    expect(isAbortError('not an error')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

import type { FSWatcher } from 'fs';

import { describe, expect, it, vi } from 'vitest';

import { startRuntimeSignalPump } from '@core/runner/runtime-signal-pump.js';

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

function fakeWatcher(input: {
  close?: () => void;
  on?: (eventName: string, listener: (error: unknown) => void) => unknown;
  unref?: () => void;
}): FSWatcher {
  return {
    close: input.close ?? vi.fn(),
    on: input.on ?? vi.fn(),
    unref: input.unref ?? vi.fn(),
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

describe('startRuntimeSignalPump', () => {
  it('wakes on completed runtime signal files and ignores temp files', () => {
    const timeouts = timeoutDeps();
    const listeners = new Map<string, WatchListener>();
    const processSignals = vi.fn(() => true);

    const pump = startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      interactionBoundaryDir: '/tmp/gantry-runner/interaction-boundaries',
      fallbackPollMs: 500,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn((dir, _options, listener) => {
          listeners.set(dir, listener);
          return fakeWatcher({});
        }),
      },
    });

    expect(timeouts.timers.map((timer) => timer.ms)).toEqual([500]);

    listeners.get('/tmp/gantry-runner/input')?.('rename', 'message-1.json.tmp');
    expect(timeouts.timers.map((timer) => timer.ms)).toEqual([500]);

    listeners.get('/tmp/gantry-runner/input')?.('rename', 'message-1.json');
    expect(timeouts.timers.at(-1)?.ms).toBe(0);
    timeouts.timers.at(-1)?.callback();
    expect(processSignals).toHaveBeenCalledTimes(1);

    listeners.get('/tmp/gantry-runner/input')?.(
      'rename',
      '.processing-message-2.json',
    );
    expect(processSignals).toHaveBeenCalledTimes(1);

    listeners.get('/tmp/gantry-runner/input')?.('rename', '_close');
    timeouts.timers.at(-1)?.callback();
    expect(processSignals).toHaveBeenCalledTimes(2);

    pump.stop();
  });

  it('wakes on interaction boundary files', () => {
    const timeouts = timeoutDeps();
    const listeners = new Map<string, WatchListener>();
    const processSignals = vi.fn(() => true);

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      interactionBoundaryDir: '/tmp/gantry-runner/interaction-boundaries',
      fallbackPollMs: 500,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn((dir, _options, listener) => {
          listeners.set(dir, listener);
          return fakeWatcher({});
        }),
      },
    });

    listeners.get('/tmp/gantry-runner/interaction-boundaries')?.(
      'rename',
      'boundary-1.json',
    );
    expect(timeouts.timers.at(-1)?.ms).toBe(0);
    timeouts.timers.at(-1)?.callback();

    expect(processSignals).toHaveBeenCalledTimes(1);
  });

  it('uses fallback polling when no filesystem event arrives', () => {
    const timeouts = timeoutDeps();
    const processSignals = vi.fn(() => true);

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      interactionBoundaryDir: '/tmp/gantry-runner/interaction-boundaries',
      fallbackPollMs: 500,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn(() => fakeWatcher({})),
      },
    });

    timeouts.timers[0]?.callback();

    expect(processSignals).toHaveBeenCalledTimes(1);
    expect(timeouts.timers.at(-1)?.ms).toBe(500);
  });

  it('backs off fallback polling after healthy filesystem wakeups', () => {
    const timeouts = timeoutDeps();
    const listeners = new Map<string, WatchListener>();
    const processSignals = vi.fn(() => true);

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      fallbackPollMs: 500,
      healthyWatchFallbackPollMs: 2_000,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn((dir, _options, listener) => {
          listeners.set(dir, listener);
          return fakeWatcher({});
        }),
      },
    });

    listeners.get('/tmp/gantry-runner/input')?.('rename', 'message-1.json');
    expect(timeouts.timers.at(-1)?.ms).toBe(0);
    timeouts.timers.at(-1)?.callback();

    expect(processSignals).toHaveBeenCalledTimes(1);
    expect(timeouts.timers.at(-1)?.ms).toBe(2_000);
  });

  it('returns to short fallback polling after a missed-event recovery pass', () => {
    const timeouts = timeoutDeps();
    const listeners = new Map<string, WatchListener>();
    const processSignals = vi.fn(() => true);

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      fallbackPollMs: 500,
      healthyWatchFallbackPollMs: 2_000,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn((dir, _options, listener) => {
          listeners.set(dir, listener);
          return fakeWatcher({});
        }),
      },
    });

    listeners.get('/tmp/gantry-runner/input')?.('rename', 'message-1.json');
    timeouts.timers.at(-1)?.callback();
    expect(timeouts.timers.at(-1)?.ms).toBe(2_000);

    timeouts.timers.at(-1)?.callback();

    expect(processSignals).toHaveBeenCalledTimes(2);
    expect(timeouts.timers.at(-1)?.ms).toBe(500);
  });

  it('uses short fallback polling after watcher error recovery', () => {
    const timeouts = timeoutDeps();
    const error = new Error('watch failed after setup');
    const onWatchError = vi.fn();
    const processSignals = vi.fn(() => true);
    let errorListener: ((error: unknown) => void) | undefined;

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      fallbackPollMs: 500,
      healthyWatchFallbackPollMs: 2_000,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        onWatchError,
        watch: vi.fn(() =>
          fakeWatcher({
            on: vi.fn((eventName, listener) => {
              if (eventName === 'error') errorListener = listener;
              return undefined;
            }),
          }),
        ),
      },
    });

    errorListener?.(error);
    expect(onWatchError).toHaveBeenCalledWith({
      dir: '/tmp/gantry-runner/input',
      error,
    });
    expect(timeouts.timers.at(-1)?.ms).toBe(0);
    timeouts.timers.at(-1)?.callback();

    expect(processSignals).toHaveBeenCalledTimes(1);
    expect(timeouts.timers.at(-1)?.ms).toBe(500);
  });

  it('stops and closes watchers when processing returns false', () => {
    const timeouts = timeoutDeps();
    const close = vi.fn();

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      interactionBoundaryDir: '/tmp/gantry-runner/interaction-boundaries',
      fallbackPollMs: 500,
      processSignals: vi.fn(() => false),
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        watch: vi.fn(() => fakeWatcher({ close })),
      },
    });

    timeouts.timers[0]?.callback();

    expect(close).toHaveBeenCalledTimes(2);
    expect(timeouts.timers).toHaveLength(1);
  });

  it('keeps fallback polling when fs.watch setup fails', () => {
    const timeouts = timeoutDeps();
    const error = new Error('watch unavailable');
    const onWatchError = vi.fn();
    const processSignals = vi.fn(() => true);

    startRuntimeSignalPump({
      inputDir: '/tmp/gantry-runner/input',
      interactionBoundaryDir: '/tmp/gantry-runner/interaction-boundaries',
      fallbackPollMs: 500,
      processSignals,
      deps: {
        setTimeout: timeouts.setTimeoutFn,
        clearTimeout: timeouts.clearTimeoutFn,
        mkdirSync: vi.fn(),
        onWatchError,
        watch: vi.fn(() => {
          throw error;
        }),
      },
    });

    expect(onWatchError).toHaveBeenCalledTimes(2);
    timeouts.timers[0]?.callback();
    expect(processSignals).toHaveBeenCalledTimes(1);
  });
});

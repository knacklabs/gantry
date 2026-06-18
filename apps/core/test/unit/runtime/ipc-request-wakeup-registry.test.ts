import type { FSWatcher } from 'fs';

import { describe, expect, it, vi } from 'vitest';

import { IpcRequestWakeupRegistry } from '@core/runtime/ipc-request-wakeup-registry.js';
import type { RunnerControlRequestLane } from '@core/runtime/runner-control-port.js';

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

function watcher(input: {
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

function runnerControlPort(input: { trusted?: Set<string>; baseDir?: string }) {
  const trusted = input.trusted ?? new Set<string>();
  const baseDir = input.baseDir ?? '/tmp/gantry-ipc';
  return {
    isTrustedRequestDir: (
      workspaceFolder: string,
      lane: RunnerControlRequestLane,
    ) => trusted.has(`${workspaceFolder}:${lane}`),
    requestDir: (workspaceFolder: string, lane: RunnerControlRequestLane) =>
      `${baseDir}/${workspaceFolder}/${lane}`,
  };
}

describe('IpcRequestWakeupRegistry', () => {
  it('watches trusted request dirs and triggers on completed json files', () => {
    const trusted = new Set(['main_agent:permission-requests']);
    const trigger = vi.fn();
    let listener: WatchListener | undefined;
    const close = vi.fn();
    const unref = vi.fn();

    const registry = new IpcRequestWakeupRegistry({
      runnerControlPort: runnerControlPort({ trusted }),
      trigger,
      deps: {
        lanes: ['permission-requests'],
        watch: vi.fn((_dir, _options, callback) => {
          listener = callback;
          return watcher({ close, unref });
        }),
      },
    });

    registry.reconcile(['main_agent']);
    listener?.('rename', 'perm-1.json.tmp');
    listener?.('rename', '.processing-perm-1.json');
    listener?.('rename', 'perm-1.json');

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith({
      workspaceFolder: 'main_agent',
      lane: 'permission-requests',
    });
    expect(unref).toHaveBeenCalledTimes(1);
    registry.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('triggers an unscoped scan when the watcher cannot identify the file', () => {
    const trusted = new Set(['main_agent:messages']);
    const trigger = vi.fn();
    let listener: WatchListener | undefined;

    const registry = new IpcRequestWakeupRegistry({
      runnerControlPort: runnerControlPort({ trusted }),
      trigger,
      deps: {
        lanes: ['messages'],
        watch: vi.fn((_dir, _options, callback) => {
          listener = callback;
          return watcher({});
        }),
      },
    });

    registry.reconcile(['main_agent']);
    listener?.('rename', null);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith();
    registry.stop();
  });

  it('closes watchers for folders or lanes that are no longer trusted', () => {
    const trusted = new Set(['main_agent:messages']);
    const close = vi.fn();
    const registry = new IpcRequestWakeupRegistry({
      runnerControlPort: runnerControlPort({ trusted }),
      trigger: vi.fn(),
      deps: {
        lanes: ['messages'],
        watch: vi.fn(() => watcher({ close })),
      },
    });

    registry.reconcile(['main_agent']);
    trusted.clear();
    registry.reconcile(['main_agent']);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('falls back silently after reporting fs.watch setup failures once per dir', () => {
    const error = new Error('watch unavailable');
    const onWatchError = vi.fn();
    const registry = new IpcRequestWakeupRegistry({
      runnerControlPort: runnerControlPort({
        trusted: new Set(['main_agent:memory-requests']),
      }),
      trigger: vi.fn(),
      deps: {
        lanes: ['memory-requests'],
        onWatchError,
        watch: vi.fn(() => {
          throw error;
        }),
      },
    });

    registry.reconcile(['main_agent']);
    registry.reconcile(['main_agent']);

    expect(onWatchError).toHaveBeenCalledTimes(1);
    expect(onWatchError).toHaveBeenCalledWith({
      workspaceFolder: 'main_agent',
      lane: 'memory-requests',
      error,
    });
  });

  it('drops failed watchers and triggers a fallback scan on watcher errors', () => {
    const trusted = new Set(['main_agent:browser-requests']);
    const trigger = vi.fn();
    const onWatchError = vi.fn();
    let errorListener: ((error: unknown) => void) | undefined;
    const close = vi.fn();

    const registry = new IpcRequestWakeupRegistry({
      runnerControlPort: runnerControlPort({ trusted }),
      trigger,
      deps: {
        lanes: ['browser-requests'],
        onWatchError,
        watch: vi.fn(() =>
          watcher({
            close,
            on: (_eventName, listener) => {
              errorListener = listener;
            },
          }),
        ),
      },
    });

    registry.reconcile(['main_agent']);
    const error = new Error('watch failed');
    errorListener?.(error);

    expect(close).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(onWatchError).toHaveBeenCalledWith({
      workspaceFolder: 'main_agent',
      lane: 'browser-requests',
      error,
    });
  });
});

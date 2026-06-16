import type { FSWatcher } from 'fs';

import { describe, expect, it, vi } from 'vitest';

import { waitForIpcResponseFile } from '@core/runner/ipc-response-wait.js';

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

function fakeWatcher(input: {
  close?: () => void;
  unref?: () => void;
}): FSWatcher {
  return {
    close: input.close ?? vi.fn(),
    unref: input.unref ?? vi.fn(),
  } as unknown as FSWatcher;
}

describe('waitForIpcResponseFile', () => {
  it('returns immediately when the response file already exists', async () => {
    const watch = vi.fn();

    await expect(
      waitForIpcResponseFile({
        responsePath: '/tmp/gantry-ipc/responses/response-1.json',
        deadlineMs: 1_000,
        deps: {
          existsSync: vi.fn(() => true),
          watch,
        },
      }),
    ).resolves.toBe(true);
    expect(watch).not.toHaveBeenCalled();
  });

  it('wakes from fs.watch when the matching response file appears', async () => {
    let listener: WatchListener | undefined;
    let exists = false;
    const close = vi.fn();
    const unref = vi.fn();
    const sleep = vi.fn(() => new Promise<void>(() => undefined));

    const wait = waitForIpcResponseFile({
      responsePath: '/tmp/gantry-ipc/responses/response-2.json',
      deadlineMs: 1_000,
      deps: {
        existsSync: vi.fn(() => exists),
        nowMs: () => 0,
        sleep,
        watch: vi.fn((_dir, _options, callback) => {
          listener = callback;
          return fakeWatcher({ close, unref });
        }),
      },
    });

    exists = true;
    listener?.('rename', 'response-2.json');

    await expect(wait).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('falls back to timed polling when fs.watch is unavailable', async () => {
    let now = 0;
    let exists = false;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      exists = true;
    });

    await expect(
      waitForIpcResponseFile({
        responsePath: '/tmp/gantry-ipc/responses/response-3.json',
        deadlineMs: 1_000,
        pollIntervalMs: 25,
        deps: {
          existsSync: vi.fn(() => exists),
          nowMs: () => now,
          sleep,
          watch: vi.fn(() => {
            throw new Error('watch unavailable');
          }),
        },
      }),
    ).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('times out and closes the watcher when no response arrives', async () => {
    let now = 0;
    const close = vi.fn();
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(
      waitForIpcResponseFile({
        responsePath: '/tmp/gantry-ipc/responses/response-4.json',
        deadlineMs: 100,
        pollIntervalMs: 25,
        deps: {
          existsSync: vi.fn(() => false),
          nowMs: () => now,
          sleep,
          watch: vi.fn(() => fakeWatcher({ close })),
        },
      }),
    ).resolves.toBe(false);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

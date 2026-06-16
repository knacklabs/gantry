import { describe, expect, it, vi } from 'vitest';

import {
  parseWarmPoolOrphanPids,
  ProcessWarmPoolOrphanReaper,
} from '@core/runtime/warm-pool-orphan-reaper.js';

describe('ProcessWarmPoolOrphanReaper', () => {
  it('parses tagged warm worker processes and skips the current pid', () => {
    expect(
      parseWarmPoolOrphanPids({
        currentPid: 42,
        marker: 'gantry-warm-pool-worker',
        processTable: [
          '  42 node --gantry-warm-pool-worker=current',
          ' 101 node runner.js --gantry-warm-pool-worker=warm-a',
          ' 102 node runner.js',
          ' 103 node runner.js --gantry-warm-pool-worker=warm-b',
        ].join('\n'),
      }),
    ).toEqual([101, 103]);
  });

  it('signals the detached process group and escalates live workers', async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      calls.push({ pid, signal });
      if (signal === 0 && pid === 101) return true;
      return true;
    });
    const reaper = new ProcessWarmPoolOrphanReaper({
      currentPid: () => 1,
      listProcesses: () =>
        '101 node runner.js --gantry-warm-pool-worker=warm-a\n',
      kill,
      settleMs: 0,
      sleep: async () => undefined,
    });

    await expect(reaper.reap('gantry-warm-pool-worker')).resolves.toBe(1);

    expect(calls).toEqual([
      { pid: -101, signal: 'SIGTERM' },
      { pid: 101, signal: 0 },
      { pid: -101, signal: 'SIGKILL' },
    ]);
  });

  it('falls back to process pid when process-group signalling is unavailable', async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      calls.push({ pid, signal });
      if (pid < 0) throw new Error('no process group');
      if (signal === 0) throw new Error('already exited');
      return true;
    });
    const reaper = new ProcessWarmPoolOrphanReaper({
      currentPid: () => 1,
      listProcesses: () =>
        '202 node runner.js --gantry-warm-pool-worker=warm-b\n',
      kill,
      settleMs: 0,
      sleep: async () => undefined,
    });

    await expect(reaper.reap('gantry-warm-pool-worker')).resolves.toBe(1);

    expect(calls).toEqual([
      { pid: -202, signal: 'SIGTERM' },
      { pid: 202, signal: 'SIGTERM' },
      { pid: 202, signal: 0 },
    ]);
  });
});

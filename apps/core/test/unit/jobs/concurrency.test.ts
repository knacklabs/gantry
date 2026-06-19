import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRunSlot,
  configureRunSlotBackend,
  resetSchedulerRunSlots,
  tryAcquireRunSlot,
} from '@core/jobs/concurrency.js';
import type { RunSlotRepository } from '@core/domain/ports/worker-coordination.js';
import { hostExecutionSlotKey } from '@core/shared/host-capacity.js';

function makeFakeRunSlotRepository(): RunSlotRepository & {
  held: Map<string, Set<string>>;
} {
  const held = new Map<string, Set<string>>();
  return {
    held,
    async acquireRunSlot(input) {
      const holders = held.get(input.slotKey) ?? new Set<string>();
      if (holders.size >= input.capacity && !holders.has(input.holderId)) {
        return false;
      }
      holders.add(input.holderId);
      held.set(input.slotKey, holders);
      return true;
    },
    async renewRunSlot(input) {
      return held.get(input.slotKey)?.has(input.holderId) === true;
    },
    async releaseRunSlot(input) {
      held.get(input.slotKey)?.delete(input.holderId);
    },
  };
}

describe('scheduler run slots', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSchedulerRunSlots();
  });

  it('throws when no cluster slot backend is configured', async () => {
    await expect(acquireRunSlot('agent-a')).rejects.toThrow(
      /Run slot backend is not configured/,
    );
  });

  it('serializes concurrent runs for the same group scope by default', async () => {
    vi.useFakeTimers();
    const repository = makeFakeRunSlotRepository();
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });
    const releaseFirst = await acquireRunSlot('agent-a');
    let secondAcquired = false;
    const second = acquireRunSlot('agent-a').then((release) => {
      secondAcquired = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(secondAcquired).toBe(false);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(200);
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);

    releaseSecond();
  });

  it('allows different group scopes to run concurrently', async () => {
    vi.useFakeTimers();
    const repository = makeFakeRunSlotRepository();
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });
    const releaseFirst = await acquireRunSlot('agent-a');
    let secondAcquired = false;
    const second = acquireRunSlot('agent-b').then((release) => {
      secondAcquired = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(0);
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);

    releaseSecond();
    releaseFirst();
  });

  it('bounds different group scopes by the shared host capacity when requested', async () => {
    const repository = makeFakeRunSlotRepository();
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });
    const releaseFirst = await tryAcquireRunSlot('agent-a', 4, {
      hostCapacity: 1,
    });
    expect(releaseFirst).toBeTypeOf('function');

    const second = await tryAcquireRunSlot('agent-b', 4, { hostCapacity: 1 });

    expect(second).toBeNull();
    releaseFirst?.();
  });

  it('tags workspace and host slots with the scheduler run id', async () => {
    const repository = makeFakeRunSlotRepository();
    const acquireSpy = vi.spyOn(repository, 'acquireRunSlot');
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });

    const release = await tryAcquireRunSlot('agent-a', 4, {
      hostCapacity: 1,
      runId: 'run-1',
    });

    expect(release).toBeTypeOf('function');
    expect(acquireSpy.mock.calls.map(([input]) => input.runId)).toEqual([
      'run-1',
      'run-1',
      'run-1',
    ]);
    release?.();
  });

  it('releases the host budget slot when class-slot acquisition throws', async () => {
    const repository = makeFakeRunSlotRepository();
    const acquireRunSlot = repository.acquireRunSlot.bind(repository);
    repository.acquireRunSlot = vi.fn(async (input) => {
      if (input.slotKey === hostExecutionSlotKey('worker-test', 'background')) {
        throw new Error('class slot unavailable');
      }
      return acquireRunSlot(input);
    });
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });

    await expect(
      tryAcquireRunSlot('agent-a', 4, {
        hostCapacity: 1,
        hostBudgetCapacity: 4,
        runId: 'run-1',
      }),
    ).rejects.toThrow('class slot unavailable');

    expect(
      repository.held.get(hostExecutionSlotKey('worker-test'))?.size ?? 0,
    ).toBe(0);
  });

  it('does not acquire a job slot when reserved chat capacity leaves no host room', async () => {
    const repository = makeFakeRunSlotRepository();
    const acquireSpy = vi.spyOn(repository, 'acquireRunSlot');
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });

    const release = await tryAcquireRunSlot('agent-a', 4, { hostCapacity: 0 });

    expect(release).toBeNull();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('does not acquire a job slot when job capacity is zero', async () => {
    const repository = makeFakeRunSlotRepository();
    const acquireSpy = vi.spyOn(repository, 'acquireRunSlot');
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });

    const release = await tryAcquireRunSlot('agent-a', 0, { hostCapacity: 4 });

    expect(release).toBeNull();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('releases the host slot when workspace slot acquisition throws', async () => {
    const repository = makeFakeRunSlotRepository();
    const acquireRunSlotImpl = repository.acquireRunSlot.bind(repository);
    let calls = 0;
    vi.spyOn(repository, 'acquireRunSlot').mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) throw new Error('workspace slot unavailable');
      return acquireRunSlotImpl(input);
    });
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });

    await expect(
      tryAcquireRunSlot('agent-a', 4, { hostCapacity: 1 }),
    ).rejects.toThrow(/workspace slot unavailable/);

    expect(
      repository.held.get(hostExecutionSlotKey('worker-test', 'background'))
        ?.size ?? 0,
    ).toBe(0);
  });

  it('returns null without polling when a slot is unavailable', async () => {
    const repository = makeFakeRunSlotRepository();
    const acquireSpy = vi.spyOn(repository, 'acquireRunSlot');
    configureRunSlotBackend({ repository, workerInstanceId: 'worker-test' });
    const releaseFirst = await acquireRunSlot('agent-a');

    const second = await tryAcquireRunSlot('agent-a');

    expect(second).toBeNull();
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    releaseFirst();
  });

  it('warns when renewal discovers a reclaimed slot', async () => {
    vi.useFakeTimers();
    const repository = makeFakeRunSlotRepository();
    const warn = vi.fn();
    configureRunSlotBackend({
      repository,
      workerInstanceId: 'worker-test',
      warn,
    });
    const release = await acquireRunSlot('agent-a');
    repository.held.get('agent-a')?.clear();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceKey: 'agent-a' }),
      'Run slot renewal failed because the slot is no longer held',
    );
    release();
  });

  it('signals when host slot renewal discovers a reclaimed slot', async () => {
    vi.useFakeTimers();
    const repository = makeFakeRunSlotRepository();
    const warn = vi.fn();
    const onSlotLost = vi.fn();
    configureRunSlotBackend({
      repository,
      workerInstanceId: 'worker-test',
      warn,
    });
    const release = await tryAcquireRunSlot('agent-a', 4, {
      hostCapacity: 1,
      onSlotLost,
    });
    expect(release).toBeDefined();
    repository.held.get(hostExecutionSlotKey('worker-test'))?.clear();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(onSlotLost).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceKey: 'agent-a' }),
      'Failed to renew host execution budget slot because it is no longer held',
    );
    release?.();
  });
});

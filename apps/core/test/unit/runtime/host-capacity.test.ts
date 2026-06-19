import { afterEach, describe, expect, it } from 'vitest';

import {
  applyHostCapacityToQueuePolicy,
  computeHostCapacityPlan,
  hostExecutionSlotKey,
} from '@core/shared/host-capacity.js';

describe('host capacity planning', () => {
  const originalHostId = process.env.GANTRY_HOST_ID;

  afterEach(() => {
    if (originalHostId === undefined) {
      delete process.env.GANTRY_HOST_ID;
    } else {
      process.env.GANTRY_HOST_ID = originalHostId;
    }
  });

  it('reserves interactive capacity before background work in all-in-one mode', () => {
    const plan = computeHostCapacityPlan({
      queue: { maxMessageRuns: 3, maxJobRuns: 4 },
      processRole: 'all',
      cpuThreads: 4,
    });

    expect(plan).toEqual({
      cpuThreads: 4,
      budget: 4,
      interactiveCapacity: 3,
      backgroundCapacity: 1,
    });
  });

  it('does not reserve interactive host budget on a dedicated job-worker process', () => {
    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 3, maxJobRuns: 4 },
        processRole: 'job-worker',
        cpuThreads: 4,
      }).backgroundCapacity,
    ).toBe(4);
    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 6, maxJobRuns: 4 },
        processRole: 'job-worker',
        cpuThreads: 2,
      }).backgroundCapacity,
    ).toBe(2);
    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 6, maxJobRuns: 4 },
        processRole: 'job-worker',
        cpuThreads: 1,
      }).backgroundCapacity,
    ).toBe(1);
  });

  it('reserves interactive budget on an explicitly shared job-worker host', () => {
    process.env.GANTRY_HOST_ID = 'shared-host';

    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 3, maxJobRuns: 4 },
        processRole: 'job-worker',
        cpuThreads: 4,
      }).backgroundCapacity,
    ).toBe(1);
    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 6, maxJobRuns: 4 },
        processRole: 'job-worker',
        cpuThreads: 2,
      }).backgroundCapacity,
    ).toBe(0);
  });

  it('does not split dedicated job-worker hosts with absent local live work', () => {
    const live = computeHostCapacityPlan({
      queue: { maxMessageRuns: 6, maxJobRuns: 4 },
      processRole: 'live-worker',
      cpuThreads: 4,
    });
    const jobs = computeHostCapacityPlan({
      queue: { maxMessageRuns: 6, maxJobRuns: 4 },
      processRole: 'job-worker',
      cpuThreads: 4,
    });

    expect(live.interactiveCapacity).toBe(2);
    expect(jobs.backgroundCapacity).toBe(4);
  });

  it('clamps runtime queue settings without adding settings keys', () => {
    expect(
      applyHostCapacityToQueuePolicy(
        { maxMessageRuns: 3, maxJobRuns: 4, maxRetries: 5 },
        'all',
        2,
      ),
    ).toMatchObject({ maxMessageRuns: 1, maxJobRuns: 1, maxRetries: 5 });
  });

  it('keeps the all-in-one host plan within the CPU budget on small hosts', () => {
    const plan = computeHostCapacityPlan({
      queue: { maxMessageRuns: 3, maxJobRuns: 4 },
      processRole: 'all',
      cpuThreads: 2,
    });

    expect(
      plan.interactiveCapacity + plan.backgroundCapacity,
    ).toBeLessThanOrEqual(plan.budget);
    expect(plan).toMatchObject({
      interactiveCapacity: 1,
      backgroundCapacity: 1,
    });
  });

  it('reserves a one-thread all-in-one host for chats first', () => {
    const plan = computeHostCapacityPlan({
      queue: { maxMessageRuns: 3, maxJobRuns: 4 },
      processRole: 'all',
      cpuThreads: 1,
    });

    expect(
      plan.interactiveCapacity + plan.backgroundCapacity,
    ).toBeLessThanOrEqual(plan.budget);
    expect(plan).toMatchObject({
      interactiveCapacity: 1,
      backgroundCapacity: 0,
    });
  });

  it('uses a one-thread all-in-one host for jobs when chats are disabled', () => {
    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 0, maxJobRuns: 4 },
        processRole: 'all',
        cpuThreads: 1,
      }).backgroundCapacity,
    ).toBe(1);
  });

  it('preserves explicit zero background capacity', () => {
    expect(
      computeHostCapacityPlan({
        queue: { maxMessageRuns: 3, maxJobRuns: 0 },
        processRole: 'job-worker',
        cpuThreads: 8,
      }).backgroundCapacity,
    ).toBe(0);
    expect(
      applyHostCapacityToQueuePolicy(
        { maxMessageRuns: 3, maxJobRuns: 0 },
        'job-worker',
        8,
      ),
    ).toMatchObject({ maxJobRuns: 0 });
  });

  it('uses one host slot key across worker processes on the same host', () => {
    process.env.GANTRY_HOST_ID = 'host-a';

    expect(hostExecutionSlotKey('live-worker-1')).toBe('host:execution:host-a');
    expect(hostExecutionSlotKey('job-worker-1')).toBe('host:execution:host-a');
    expect(hostExecutionSlotKey('live-worker-1', 'interactive')).toBe(
      'host:execution:host-a:interactive',
    );
    expect(hostExecutionSlotKey('job-worker-1', 'background')).toBe(
      'host:execution:host-a:background',
    );
  });

  it('keeps host slot keys process-local when no shared host id is configured', () => {
    delete process.env.GANTRY_HOST_ID;

    expect(hostExecutionSlotKey('live-worker-1')).toBe(
      'host:execution:worker:live-worker-1',
    );
    expect(hostExecutionSlotKey('job-worker-1')).toBe(
      'host:execution:worker:job-worker-1',
    );
  });

  it('sanitizes host slot identity before using it as a slot key', () => {
    process.env.GANTRY_HOST_ID = 'host name/with spaces';

    expect(hostExecutionSlotKey('w1')).toBe(
      'host:execution:host_name_with_spaces',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { settleSchedulerRunLease } from '@core/jobs/execution-lease.js';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    deps: {
      opsRepository: {
        settleJobRunLease: vi.fn(async () => true),
      },
    },
    currentJob: { id: 'job-1' },
    runId: 'run-1',
    leaseContext: {
      lease: {
        runId: 'run-1',
        jobId: 'job-1',
        workerInstanceId: 'worker-1',
        leaseToken: 'lease-token-1',
        fencingVersion: 1,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      },
      recordRunnerControlEvent: vi.fn(async () => undefined),
    },
    error: null,
    warn: vi.fn(),
    ...overrides,
  } as any;
}

describe('settleSchedulerRunLease', () => {
  it('records terminal control evidence after successful settlement', async () => {
    const input = baseInput();

    await expect(settleSchedulerRunLease(input)).resolves.toBe(true);

    expect(input.deps.opsRepository.settleJobRunLease).toHaveBeenCalledWith({
      runId: 'run-1',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 1,
      outcome: 'completed',
    });
    expect(input.leaseContext.recordRunnerControlEvent).toHaveBeenCalledWith(
      'terminal_state',
      {
        outcome: 'completed',
        fencingVersion: 1,
      },
    );
  });

  it('does not record terminal control evidence when settlement fails', async () => {
    const input = baseInput({
      deps: {
        opsRepository: {
          settleJobRunLease: vi.fn(async () => false),
        },
      },
    });

    await expect(settleSchedulerRunLease(input)).resolves.toBe(false);

    expect(input.leaseContext.recordRunnerControlEvent).not.toHaveBeenCalled();
  });
});

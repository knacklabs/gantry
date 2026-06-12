import { describe, expect, it, vi } from 'vitest';

import { completeFailedRunFailsafe } from '@core/jobs/run-failsafe.js';

describe('completeFailedRunFailsafe', () => {
  it('writes terminal failure evidence atomically with lease settlement', async () => {
    const opsRepository = {
      finalizeJobRunLease: vi.fn(async () => true),
    };
    const logger = {
      warn: vi.fn(),
    };
    const recordRunnerControlEvent = vi.fn(async () => undefined);

    await completeFailedRunFailsafe({
      opsRepository: opsRepository as never,
      jobId: 'job-1',
      runId: 'run-1',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 2,
      recordRunnerControlEvent,
      logger,
    });

    expect(opsRepository.finalizeJobRunLease).toHaveBeenCalledWith({
      runId: 'run-1',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 2,
      leaseOutcome: 'failed',
      runStatus: 'failed',
      resultSummary: null,
      errorSummary: 'Scheduler run failed before terminal settlement.',
    });
    expect(recordRunnerControlEvent).toHaveBeenCalledWith('terminal_state', {
      outcome: 'failed',
      fencingVersion: 2,
      failsafe: true,
    });
  });

  it('does not write terminal state after losing the lease', async () => {
    const opsRepository = {
      finalizeJobRunLease: vi.fn(async () => false),
    };
    const logger = {
      warn: vi.fn(),
    };
    const recordRunnerControlEvent = vi.fn(async () => undefined);

    await completeFailedRunFailsafe({
      opsRepository: opsRepository as never,
      jobId: 'job-1',
      runId: 'run-1',
      leaseToken: 'stale-token',
      workerInstanceId: 'worker-1',
      fencingVersion: 2,
      recordRunnerControlEvent,
      logger,
    });

    expect(recordRunnerControlEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: 'job-1', runId: 'run-1' },
      'Skipped run failsafe terminal write: lease is no longer held',
    );
  });
});

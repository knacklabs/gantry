import type { SchedulerDependencies } from './types.js';

type LoggerLike = {
  warn(input: unknown, message: string): void;
};

export async function completeFailedRunFailsafe(input: {
  opsRepository: SchedulerDependencies['opsRepository'];
  jobId: string;
  runId: string;
  leaseToken: string;
  workerInstanceId: string;
  fencingVersion: number;
  recordRunnerControlEvent?: (
    eventType: 'terminal_state',
    payload: Record<string, unknown>,
  ) => Promise<void>;
  logger: LoggerLike;
}): Promise<void> {
  try {
    // Token-fenced: a stale worker whose lease was recovered must not write
    // terminal state. If the lease is no longer ours, drop the failsafe and
    // let stale-lease recovery time the run out.
    const finalizeRunLease = input.opsRepository.finalizeJobRunLease;
    if (!finalizeRunLease) {
      input.logger.warn(
        { jobId: input.jobId, runId: input.runId },
        'Skipped run failsafe terminal write: lease finalization is unavailable',
      );
      return;
    }
    const finalized = await finalizeRunLease.call(input.opsRepository, {
      runId: input.runId,
      leaseToken: input.leaseToken,
      workerInstanceId: input.workerInstanceId,
      fencingVersion: input.fencingVersion,
      leaseOutcome: 'failed',
      runStatus: 'failed',
      resultSummary: null,
      errorSummary: 'Scheduler run failed before terminal settlement.',
    });
    if (!finalized) {
      input.logger.warn(
        { jobId: input.jobId, runId: input.runId },
        'Skipped run failsafe terminal write: lease is no longer held',
      );
      return;
    }
    await input.recordRunnerControlEvent?.('terminal_state', {
      outcome: 'failed',
      fencingVersion: input.fencingVersion,
      failsafe: true,
    });
  } catch (err) {
    input.logger.warn(
      { err, jobId: input.jobId, runId: input.runId },
      'Failed to record scheduler run failsafe terminal state',
    );
  }
}

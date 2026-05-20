import type { SchedulerDependencies } from './types.js';

type LoggerLike = {
  warn(input: unknown, message: string): void;
};

export async function completeFailedRunFailsafe(input: {
  opsRepository: SchedulerDependencies['opsRepository'];
  jobId: string;
  runId: string;
  logger: LoggerLike;
}): Promise<void> {
  await input.opsRepository
    .completeJobRun(
      input.runId,
      'failed',
      null,
      'Scheduler run failed before terminal settlement.',
    )
    .catch((err) => {
      input.logger.warn(
        { err, jobId: input.jobId, runId: input.runId },
        'Failed to record scheduler run failsafe terminal state',
      );
    });
}

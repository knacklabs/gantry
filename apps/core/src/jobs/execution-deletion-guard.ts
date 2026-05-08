const JOB_DELETION_CHECK_INTERVAL_MS = 1_000;

type ExecutionDeletionGuardLogger = {
  debug(metadata: Record<string, unknown>, message: string): void;
  info(metadata: Record<string, unknown>, message: string): void;
};

export function createJobExecutionDeletionGuard(input: {
  jobId: string;
  runId: string;
  nowMs: () => number;
  getJobById: (jobId: string) => Promise<unknown>;
  log: ExecutionDeletionGuardLogger;
}) {
  let deletedDuringRun = false;
  let lastJobDeletionCheckAt = 0;
  let firstDeliveryDeletionCheckDone = false;

  const isJobDeleted = async (force = false): Promise<boolean> => {
    if (deletedDuringRun) return true;
    const now = input.nowMs();
    if (
      !force &&
      now - lastJobDeletionCheckAt < JOB_DELETION_CHECK_INTERVAL_MS
    ) {
      return false;
    }
    lastJobDeletionCheckAt = now;
    let jobStillExists: boolean;
    try {
      jobStillExists = Boolean(await input.getJobById(input.jobId));
    } catch (err) {
      deletedDuringRun = true;
      input.log.debug(
        { jobId: input.jobId, runId: input.runId, err },
        'Scheduler run observed closed storage while checking job state',
      );
      return true;
    }
    if (jobStillExists) return false;
    deletedDuringRun = true;
    input.log.info(
      { jobId: input.jobId, runId: input.runId },
      'Scheduler job deleted while run was active',
    );
    return true;
  };

  return {
    isJobDeleted,
    resetDeliveryDeletionCheck(): void {
      firstDeliveryDeletionCheckDone = false;
    },
    async shouldSuppressDelivery(): Promise<boolean> {
      const force = !firstDeliveryDeletionCheckDone;
      firstDeliveryDeletionCheckDone = true;
      return isJobDeleted(force);
    },
    get deletedDuringRun(): boolean {
      return deletedDuringRun;
    },
  };
}

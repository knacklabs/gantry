const JOB_DELETION_CHECK_INTERVAL_MS = 1_000;
export function createJobExecutionDeletionGuard(input) {
    let deletedDuringRun = false;
    let lastJobDeletionCheckAt = 0;
    let firstDeliveryDeletionCheckDone = false;
    const isJobDeleted = async (force = false) => {
        if (deletedDuringRun)
            return true;
        const now = input.nowMs();
        if (!force &&
            now - lastJobDeletionCheckAt < JOB_DELETION_CHECK_INTERVAL_MS) {
            return false;
        }
        lastJobDeletionCheckAt = now;
        let jobStillExists;
        try {
            jobStillExists = Boolean(await input.getJobById(input.jobId));
        }
        catch (err) {
            deletedDuringRun = true;
            input.log.debug({ jobId: input.jobId, runId: input.runId, err }, 'Scheduler run observed closed storage while checking job state');
            return true;
        }
        if (jobStillExists)
            return false;
        deletedDuringRun = true;
        input.log.info({ jobId: input.jobId, runId: input.runId }, 'Scheduler job deleted while run was active');
        return true;
    };
    return {
        isJobDeleted,
        resetDeliveryDeletionCheck() {
            firstDeliveryDeletionCheckDone = false;
        },
        async shouldSuppressDelivery() {
            const force = !firstDeliveryDeletionCheckDone;
            firstDeliveryDeletionCheckDone = true;
            return isJobDeleted(force);
        },
        get deletedDuringRun() {
            return deletedDuringRun;
        },
    };
}

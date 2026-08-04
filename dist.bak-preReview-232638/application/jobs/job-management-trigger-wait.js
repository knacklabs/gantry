import { ApplicationError } from '../common/application-error.js';
import { requireJobControl } from './job-management-require.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
const TRIGGER_POLL_INTERVAL_MS = 2_000;
export async function waitForTriggerCompletion(input) {
    const control = requireJobControl(input.deps);
    const initialTrigger = await control.getTriggerById(input.triggerId);
    if (!initialTrigger) {
        throw new ApplicationError('TRIGGER_NOT_FOUND', 'Trigger not found');
    }
    const job = await input.requireJob(initialTrigger.jobId);
    await input.assertJobAppAccess(job, input.appId);
    const startedAt = currentTimeMs();
    const subscription = input.deps.runtimeEvents?.subscribe?.({
        appId: input.appId,
        triggerId: input.triggerId,
    });
    try {
        while (currentTimeMs() - startedAt < input.timeoutMs) {
            const completed = await getCompletedTriggerRun(input.deps, input.triggerId);
            if (completed)
                return completed;
            const remaining = input.timeoutMs - (currentTimeMs() - startedAt);
            if (remaining <= 0)
                break;
            if (subscription) {
                await subscription.next({
                    timeoutMs: Math.min(remaining, TRIGGER_POLL_INTERVAL_MS),
                });
            }
            else {
                await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, TRIGGER_POLL_INTERVAL_MS)));
            }
        }
    }
    finally {
        subscription?.close();
    }
    throw new ApplicationError('WAIT_TIMEOUT', 'Timed out waiting for trigger completion');
}
async function getCompletedTriggerRun(deps, triggerId) {
    const control = requireJobControl(deps);
    const trigger = await control.getTriggerById(triggerId);
    if (!trigger)
        throw new ApplicationError('TRIGGER_NOT_FOUND', 'Trigger not found');
    if (!trigger.runId)
        return null;
    const run = await deps.ops.getJobRunById(trigger.runId);
    if (!run || run.status === 'running')
        return null;
    return {
        triggerId: trigger.triggerId,
        runId: run.run_id,
        status: run.status,
        resultSummary: run.result_summary,
        errorSummary: run.error_summary,
    };
}

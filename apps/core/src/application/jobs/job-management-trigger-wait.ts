import { ApplicationError } from '../common/application-error.js';
import type { Job, JobManagementServiceDeps } from './job-management-types.js';
import { requireJobControl } from './job-management-require.js';

const TRIGGER_POLL_INTERVAL_MS = 2_000;

export interface CompletedTriggerRun {
  triggerId: string;
  runId: string;
  status: string;
  resultSummary: string | null;
  errorSummary: string | null;
}

export async function waitForTriggerCompletion(input: {
  deps: JobManagementServiceDeps;
  appId: string;
  triggerId: string;
  timeoutMs: number;
  requireJob: (jobId: string) => Promise<Job>;
  assertJobAppAccess: (job: Job, appId: string) => Promise<void>;
}): Promise<CompletedTriggerRun> {
  const control = requireJobControl(input.deps);
  const initialTrigger = await control.getTriggerById(input.triggerId);
  if (!initialTrigger) {
    throw new ApplicationError('TRIGGER_NOT_FOUND', 'Trigger not found');
  }
  const job = await input.requireJob(initialTrigger.jobId);
  await input.assertJobAppAccess(job, input.appId);
  const startedAt = Date.now();
  const subscription = input.deps.runtimeEvents?.subscribe?.({
    appId: input.appId as never,
    triggerId: input.triggerId,
  });
  try {
    while (Date.now() - startedAt < input.timeoutMs) {
      const completed = await getCompletedTriggerRun(
        input.deps,
        input.triggerId,
      );
      if (completed) return completed;
      const remaining = input.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      if (subscription) {
        await subscription.next({
          timeoutMs: Math.min(remaining, TRIGGER_POLL_INTERVAL_MS),
        });
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(remaining, TRIGGER_POLL_INTERVAL_MS)),
        );
      }
    }
  } finally {
    subscription?.close();
  }
  throw new ApplicationError(
    'WAIT_TIMEOUT',
    'Timed out waiting for trigger completion',
  );
}

async function getCompletedTriggerRun(
  deps: JobManagementServiceDeps,
  triggerId: string,
): Promise<CompletedTriggerRun | null> {
  const control = requireJobControl(deps);
  const trigger = await control.getTriggerById(triggerId);
  if (!trigger)
    throw new ApplicationError('TRIGGER_NOT_FOUND', 'Trigger not found');
  if (!trigger.runId) return null;
  const run = await deps.ops.getJobRunById(trigger.runId);
  if (!run || run.status === 'running') return null;
  return {
    triggerId: trigger.triggerId,
    runId: run.run_id,
    status: run.status,
    resultSummary: run.result_summary,
    errorSummary: run.error_summary,
  };
}

import type { Job } from '../domain/types.js';
import { randomUUID } from 'node:crypto';
import { withLogContext } from '../infrastructure/logging/logger.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { nowIso } from '../shared/time/datetime.js';
import { resolveJobExecutionAgentId } from './execution-context.js';

export interface ActiveJobRunContext {
  job: Job;
  runId: string;
  scheduledFor: string;
}

export async function runActiveJobWithLogContext(input: {
  requestedJob: Job;
  dispatch?: { runId?: string | null; scheduledFor?: string | null };
  getJobById: (jobId: string) => Promise<Job | null | undefined>;
  run: (context: ActiveJobRunContext) => Promise<void>;
}): Promise<void> {
  const job = await input.getJobById(input.requestedJob.id);
  if (!job || job.status !== 'active') return;
  const scheduledFor = input.dispatch?.scheduledFor || job.next_run || nowIso();
  const runId = input.dispatch?.runId ?? randomUUID();
  return withLogContext(
    {
      runId,
      appId: DEFAULT_JOB_RUNTIME_APP_ID,
      agentId: resolveJobExecutionAgentId(job),
    },
    () => input.run({ job, runId, scheduledFor }),
  );
}

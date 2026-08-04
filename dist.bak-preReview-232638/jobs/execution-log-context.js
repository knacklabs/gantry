import { randomUUID } from 'node:crypto';
import { withLogContext } from '../infrastructure/logging/logger.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { nowIso } from '../shared/time/datetime.js';
import { resolveJobExecutionAgentId } from './execution-context.js';
export async function runActiveJobWithLogContext(input) {
    const job = await input.getJobById(input.requestedJob.id);
    if (!job || job.status !== 'active')
        return;
    const scheduledFor = input.dispatch?.scheduledFor || job.next_run || nowIso();
    const runId = input.dispatch?.runId ?? randomUUID();
    return withLogContext({
        runId,
        appId: DEFAULT_JOB_RUNTIME_APP_ID,
        agentId: resolveJobExecutionAgentId(job),
    }, () => input.run({ job, runId, scheduledFor }));
}

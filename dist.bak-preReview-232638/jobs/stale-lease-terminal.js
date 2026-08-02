import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { RUNTIME_EVENT_TYPES, } from '../domain/events/runtime-event-types.js';
import { nowMs } from '../shared/time/datetime.js';
import { resolveAppSessionForJob, } from './app-session-resolution.js';
import { notifySchedulerTerminalRunState } from './execution-notifications.js';
import { publishSchedulerRunCompletion } from './execution-completion-events.js';
import { runtimeEventTypeForRunStatus } from './run-status-event.js';
const STALE_LEASE_TIMEOUT_SUMMARY = 'Scheduler run lease expired before completion.';
export async function notifyReleasedStaleJobLeases(input) {
    const runtimeAppId = input.runtimeAppId ?? DEFAULT_JOB_RUNTIME_APP_ID;
    const log = input.logger ?? NOOP_LOGGER;
    for (const release of input.releases) {
        if (!release.runId || !release.runTimedOut)
            continue;
        await notifyReleasedStaleJobLease({
            release,
            opsRepository: input.opsRepository,
            sendMessage: input.sendMessage,
            control: input.controlRepository,
            publishRuntimeEvent: input.publishRuntimeEvent,
            runtimeAppId,
            logger: log,
        });
    }
}
const NOOP_LOGGER = {
    warn: () => undefined,
};
async function notifyReleasedStaleJobLease(input) {
    const { release } = input;
    const runId = release.runId;
    if (!runId)
        return;
    try {
        const [job, run] = await Promise.all([
            input.opsRepository.getJobById(release.jobId),
            input.opsRepository.getJobRunById(runId),
        ]);
        if (!job) {
            input.logger.warn({ jobId: release.jobId, runId }, 'Skipped stale scheduler lease notification for missing job');
            return;
        }
        let eventAppSession;
        const resolveEventAppSession = async () => {
            eventAppSession =
                eventAppSession ?? (await resolveAppSessionForJob(job, input.control));
            return eventAppSession;
        };
        const retryCount = run?.retry_count ?? 0;
        const durationMs = durationMsForRun(run);
        const nextRun = job.next_run;
        const summary = summaryForReleasedLease(release, run);
        await publishSchedulerLifecycleEvent({
            job,
            runId,
            eventType: runtimeEventTypeForRunStatus('timeout'),
            payload: {
                next_run: nextRun,
                retry_count: retryCount,
                stale_lease: release.reason === 'lease_expired',
                interruption_reason: release.reason,
            },
            resolveEventAppSession,
            publishRuntimeEvent: input.publishRuntimeEvent,
            runtimeAppId: input.runtimeAppId,
            logger: input.logger,
        });
        const notified = await notifySchedulerTerminalRunState({
            job,
            runId,
            runStatus: 'timeout',
            summary,
            nextRun,
            retryCount,
            pauseReason: job.pause_reason,
            durationMs,
            sendMessage: input.sendMessage,
        });
        if (notified)
            await input.opsRepository.markJobRunNotified(runId);
        await publishSchedulerLifecycleEvent({
            job,
            runId,
            eventType: RUNTIME_EVENT_TYPES.JOB_FAILED,
            payload: {
                status: 'timeout',
                delivery_state: notified ? 'sent' : 'not_sent',
                start_notification_state: 'not_sent',
                next_run: nextRun,
                retry_count: retryCount,
                pause_reason: job.pause_reason,
                notified,
                summary,
                stale_lease: release.reason === 'lease_expired',
                interruption_reason: release.reason,
            },
            resolveEventAppSession,
            publishRuntimeEvent: input.publishRuntimeEvent,
            runtimeAppId: input.runtimeAppId,
            logger: input.logger,
        });
        eventAppSession = await publishSchedulerRunCompletion({
            currentJob: job,
            runId,
            runStatus: 'timeout',
            notified,
            startNotified: false,
            summary,
            nextRun,
            eventAppSession,
            resolveEventAppSession,
            markTriggerCompleted: async () => undefined,
            publishRuntimeEvent: input.publishRuntimeEvent,
            runtimeAppId: input.runtimeAppId,
            logger: input.logger,
        });
    }
    catch (err) {
        input.logger.warn({ err, jobId: release.jobId, runId }, 'Failed to publish stale scheduler lease terminal evidence');
    }
}
function summaryForReleasedLease(_release, run) {
    return run?.error_summary || STALE_LEASE_TIMEOUT_SUMMARY;
}
async function publishSchedulerLifecycleEvent(input) {
    try {
        const appSession = await input.resolveEventAppSession();
        const eventAppId = appSession?.appId ?? input.runtimeAppId;
        if (!eventAppId)
            return;
        await input.publishRuntimeEvent({
            appId: eventAppId,
            eventType: input.eventType,
            payload: input.payload,
            actor: 'scheduler',
            sessionId: appSession?.sessionId,
            jobId: input.job.id,
            runId: input.runId,
            responseMode: appSession?.defaultResponseMode,
            webhookId: appSession?.defaultWebhookId,
        });
    }
    catch (err) {
        input.logger.warn({
            err,
            jobId: input.job.id,
            runId: input.runId,
            eventType: input.eventType,
        }, 'Failed to write scheduler lifecycle event');
    }
}
function durationMsForRun(run) {
    if (!run?.started_at)
        return undefined;
    const started = Date.parse(run.started_at);
    const ended = run.ended_at ? Date.parse(run.ended_at) : nowMs();
    if (!Number.isFinite(started) || !Number.isFinite(ended))
        return undefined;
    return Math.max(0, ended - started);
}

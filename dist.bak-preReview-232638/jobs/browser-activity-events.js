import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { resolveAppSessionForJob, } from './app-session-resolution.js';
export async function publishBrowserJobActivityEvent(input) {
    const log = input.logger ?? NOOP_LOGGER;
    const activity = input.activity;
    const runtimeAppId = input.runtimeAppId ?? DEFAULT_JOB_RUNTIME_APP_ID;
    let eventAppSession;
    try {
        const job = await input.getJobById(activity.jobId);
        if (job) {
            eventAppSession = await resolveAppSessionForJob(job, input.controlRepository);
        }
    }
    catch (err) {
        log.warn({ err, jobId: activity.jobId, runId: activity.runId }, 'Failed to resolve app session for browser job activity event');
    }
    await input.publishRuntimeEvent({
        appId: (eventAppSession?.appId ?? runtimeAppId),
        eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        actor: 'browser',
        sessionId: eventAppSession?.sessionId,
        jobId: activity.jobId,
        runId: activity.runId,
        responseMode: eventAppSession?.defaultResponseMode,
        webhookId: eventAppSession?.defaultWebhookId,
        payload: {
            tool: activity.tool,
            public_tool: activity.publicToolName ?? null,
            action: activity.action ?? null,
            ok: activity.ok,
            elapsed_ms: activity.elapsedMs,
            normalized_site: activity.normalizedSite ?? null,
            policy_mode: activity.policyMode ?? null,
            warning: activity.warning ?? null,
            error: activity.error ?? null,
        },
    });
}
const NOOP_LOGGER = {
    warn: () => undefined,
};

import { RUNTIME_EVENT_TYPES, } from '../domain/events/runtime-event-types.js';
import { resolveAppSessionForJob, resolveAppSessionForTrigger, } from './app-session-resolution.js';
import { publishSchedulerRunCompletion } from './execution-completion-events.js';
export function createRuntimeEventPublisher(input) {
    return (event) => input.publish(event).then(() => undefined);
}
export async function bindSchedulerRunEventState(input) {
    try {
        const boundTrigger = input.dispatch?.triggerId
            ? await input.control.bindTriggerToRun(input.dispatch.triggerId, input.runId)
            : await input.control.bindPendingTriggerToRun(input.currentJob.id, input.runId);
        const eventAppSession = (boundTrigger
            ? await resolveAppSessionForTrigger(boundTrigger.requestedBy, input.control)
            : undefined) ??
            (await resolveAppSessionForJob(input.currentJob, input.control));
        const startEventAppId = eventAppSession?.appId ?? input.runtimeAppId;
        if (startEventAppId) {
            await input.publishRuntimeEvent({
                appId: startEventAppId,
                eventType: RUNTIME_EVENT_TYPES.JOB_RUN_STARTED,
                payload: {
                    jobId: input.currentJob.id,
                    runId: input.runId,
                    short_id: input.runShortId,
                    scheduledFor: input.scheduledFor,
                },
                actor: 'scheduler',
                sessionId: eventAppSession?.sessionId,
                jobId: input.currentJob.id,
                runId: input.runId,
                triggerId: boundTrigger?.triggerId,
                responseMode: eventAppSession?.defaultResponseMode,
                webhookId: eventAppSession?.defaultWebhookId,
            });
        }
        return {
            boundTriggerId: boundTrigger?.triggerId,
            eventAppSession,
        };
    }
    catch (err) {
        input.logger.warn({ err, jobId: input.currentJob.id, runId: input.runId }, 'Failed to bind scheduler run event state');
        return {};
    }
}
export function createSchedulerJobEventEmitter(input) {
    return async (eventType, payload) => {
        if (await input.deletionGuard.isJobDeleted(true))
            return;
        try {
            const appSession = input.state.eventAppSession ?? (await input.resolveEventAppSession());
            const eventAppId = appSession?.appId ?? input.runtimeAppId;
            if (!eventAppId)
                return;
            await input.publishRuntimeEvent({
                appId: eventAppId,
                eventType,
                payload,
                actor: 'scheduler',
                sessionId: appSession?.sessionId,
                jobId: input.currentJob.id,
                runId: input.runId,
                triggerId: input.state.boundTriggerId,
                responseMode: appSession?.defaultResponseMode,
                webhookId: appSession?.defaultWebhookId,
            });
        }
        catch (err) {
            input.logger.warn({ err, jobId: input.currentJob.id, runId: input.runId, eventType }, 'Failed to write scheduler lifecycle event');
        }
    };
}
export async function publishSchedulerCompletionEvent(input) {
    input.state.eventAppSession = await publishSchedulerRunCompletion({
        currentJob: input.currentJob,
        runId: input.runId,
        runStatus: input.runStatus,
        notified: input.notified,
        startNotified: input.startNotified,
        summary: input.summary,
        nextRun: input.nextRun,
        boundTriggerId: input.state.boundTriggerId,
        eventAppSession: input.state.eventAppSession,
        resolveEventAppSession: () => resolveAppSessionForJob(input.currentJob, input.control),
        markTriggerCompleted: (status) => input.control.markTriggerCompleted(input.state.boundTriggerId, status),
        publishRuntimeEvent: async (event) => {
            await input.publishRuntimeEvent(event);
        },
        runtimeAppId: input.runtimeAppId,
        logger: input.logger,
    });
}

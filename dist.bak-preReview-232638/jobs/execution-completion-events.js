import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
export async function publishSchedulerRunCompletion(input) {
    let eventAppSession = input.eventAppSession;
    try {
        eventAppSession = eventAppSession ?? (await input.resolveEventAppSession());
        if (input.boundTriggerId) {
            await input.markTriggerCompleted(input.runStatus === 'completed' ? 'completed' : 'failed');
        }
        const completionEventAppId = eventAppSession?.appId ?? input.runtimeAppId;
        if (!completionEventAppId)
            return eventAppSession;
        await input.publishRuntimeEvent({
            appId: completionEventAppId,
            eventType: input.runStatus === 'completed'
                ? RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED
                : RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
            payload: {
                jobId: input.currentJob.id,
                runId: input.runId,
                status: input.runStatus,
                deliveryState: input.notified ? 'sent' : 'not_sent',
                startNotificationState: input.startNotified ? 'sent' : 'not_sent',
                summary: input.summary,
                nextRun: input.nextRun,
            },
            actor: 'scheduler',
            sessionId: eventAppSession?.sessionId,
            jobId: input.currentJob.id,
            runId: input.runId,
            triggerId: input.boundTriggerId,
            responseMode: eventAppSession?.defaultResponseMode,
            webhookId: eventAppSession?.defaultWebhookId,
        });
    }
    catch (err) {
        input.logger.warn({ err, jobId: input.currentJob.id, runId: input.runId }, 'Failed to publish scheduler run completion event');
    }
    return eventAppSession;
}

import { isRuntimeEventType, RUNTIME_EVENT_TYPES, } from '../domain/events/runtime-event-types.js';
import { logger } from '../infrastructure/logging/logger.js';
export { RUNTIME_EVENT_TYPES };
function runtimeEventDedupKey(input) {
    let payload;
    try {
        payload = JSON.stringify(input.payload) ?? 'undefined';
    }
    catch {
        payload = String(input.payload);
    }
    return [
        input.eventType,
        input.appId ?? '',
        input.agentId ?? '',
        input.runId ?? '',
        input.jobId ?? '',
        input.conversationId ?? '',
        input.threadId ?? '',
        payload,
    ].join('\u001f');
}
export async function forwardRuntimeEvents(input) {
    const { output, publishRuntimeEvent } = input;
    if (!output.runtimeEvents?.length || !publishRuntimeEvent)
        return;
    for (const event of output.runtimeEvents) {
        if (!isRuntimeEventType(event.eventType))
            continue;
        const appId = event.appId ?? input.runtimeAppId;
        if (!appId)
            continue;
        const eventKey = runtimeEventDedupKey({
            eventType: event.eventType,
            appId,
            agentId: event.agentId ?? input.turnAgentId,
            runId: event.runId ?? input.runId,
            jobId: event.jobId,
            conversationId: event.conversationId ?? input.chatJid,
            threadId: event.threadId ?? input.sessionThreadId,
            payload: event.payload,
        });
        if (input.forwardedKeys.has(eventKey))
            continue;
        try {
            await publishRuntimeEvent({
                appId: appId,
                ...((event.agentId ?? input.turnAgentId)
                    ? { agentId: (event.agentId ?? input.turnAgentId) }
                    : {}),
                ...((event.runId ?? input.runId)
                    ? { runId: (event.runId ?? input.runId) }
                    : {}),
                ...(event.jobId ? { jobId: event.jobId } : {}),
                conversationId: (event.conversationId ?? input.chatJid),
                ...((event.threadId ?? input.sessionThreadId)
                    ? { threadId: (event.threadId ?? input.sessionThreadId) }
                    : {}),
                eventType: event.eventType,
                actor: event.actor ?? 'runner',
                responseMode: event.responseMode ?? 'none',
                payload: event.payload,
            });
            // Mark forwarded only after a successful publish so a failed event
            // remains retriable on a later forwarding pass in the same turn.
            input.forwardedKeys.add(eventKey);
        }
        catch (error) {
            // Runtime events are observability/audit breadcrumbs. They must not
            // fail a user-visible turn when storage is temporarily unhealthy or
            // schema drift is being repaired. The key is intentionally NOT added,
            // so a later forwarding pass can retry this event.
            logger.warn({
                error,
                eventType: event.eventType,
                conversationId: event.conversationId ?? input.chatJid,
                runId: event.runId ?? input.runId,
                agentId: event.agentId ?? input.turnAgentId,
            }, 'Failed to persist forwarded runtime event; will remain retriable');
        }
    }
}

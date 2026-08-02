import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
export async function publishPermissionRuntimeEvent(deps, request, input) {
    if (!deps.publishRuntimeEvent || !request.appId)
        return;
    try {
        await deps.publishRuntimeEvent({
            appId: request.appId,
            agentId: request.agentId,
            runId: request.runId,
            jobId: request.jobId,
            conversationId: request.targetJid,
            threadId: request.threadId,
            eventType: input.eventType,
            actor: 'permission',
            correlationId: request.requestId,
            payload: input.payload,
        });
    }
    catch {
        // Runtime-event telemetry is best-effort; permission IPC response delivery
        // must not fail because event persistence is temporarily unavailable.
    }
}
export async function publishPendingInteractionRuntimeEvent(deps, request, kind, sourceAgentFolder) {
    if (!deps.publishRuntimeEvent)
        return;
    try {
        await deps.publishRuntimeEvent({
            appId: (request.appId ?? 'default'),
            agentId: request.agentId,
            runId: request.runId,
            jobId: request.jobId,
            conversationId: request.targetJid,
            threadId: request.threadId,
            eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
            actor: 'interaction',
            correlationId: request.requestId,
            payload: {
                kind,
                requestId: request.requestId,
                sourceAgentFolder,
                status: 'pending',
            },
        });
    }
    catch {
        // Durable interaction recording succeeded; wakeup telemetry is best-effort.
    }
}

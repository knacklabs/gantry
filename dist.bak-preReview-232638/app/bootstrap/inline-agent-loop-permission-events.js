export async function publishInlinePermissionEvent(deps, request, eventType, payload) {
    if (!deps.publishRuntimeEvent || !request.appId)
        return;
    await deps
        .publishRuntimeEvent({
        appId: request.appId,
        agentId: request.agentId,
        runId: request.runId,
        jobId: request.jobId,
        conversationId: request.targetJid,
        threadId: request.threadId,
        eventType,
        actor: 'permission',
        correlationId: request.requestId,
        payload,
    })
        .catch(() => undefined);
}

export function requestOnlyCapabilityPendingKey(input) {
    return JSON.stringify({
        toolName: input.review.toolName,
        appId: input.data.appId,
        agent: input.sourceAgentFolder,
        targetJid: input.targetJid,
        threadId: input.data.authThreadId ?? null,
        jobId: input.data.jobId ?? null,
        toolInput: input.review.toolInput,
    });
}

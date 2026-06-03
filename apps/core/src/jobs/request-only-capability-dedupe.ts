export function requestOnlyCapabilityPendingKey(input: {
  data: {
    appId?: string;
    authThreadId?: string;
    jobId?: string;
  };
  sourceAgentFolder: string;
  targetJid: string;
  review: {
    toolName: string;
    toolInput: Record<string, unknown>;
  };
}): string {
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

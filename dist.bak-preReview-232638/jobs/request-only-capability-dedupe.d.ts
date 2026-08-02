export declare function requestOnlyCapabilityPendingKey(input: {
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
}): string;

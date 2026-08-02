export declare function runDreamingForGroup(input: {
    folder: string;
    conversationId?: string;
    userId?: string;
    defaultScope?: 'user' | 'group';
    activeThreadId?: string;
    signal?: AbortSignal;
    deadlineAtMs?: number;
}): Promise<{
    queued: boolean;
    pending: number;
    deduped: boolean;
    reason: "full" | "queued" | "invalid" | "deduped";
}>;

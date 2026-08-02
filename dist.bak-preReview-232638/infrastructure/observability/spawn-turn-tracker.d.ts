interface TurnInputLike {
    runId?: string;
    parentRunId?: string;
    parentTaskId?: string;
    appId?: string;
    agentId?: string;
    chatJid?: string;
    threadId?: string;
    jobId?: string;
    memoryUserId?: string;
    prompt: string;
}
interface TurnFrameLike {
    status: string;
    result: string | null;
    error?: string;
    continuedByFollowup?: boolean;
}
export interface SpawnTurnTracker<F extends TurnFrameLike> {
    correlationId: string;
    traceId: () => string | undefined;
    onOutput: ((frame: F) => Promise<void>) | undefined;
    finish: (output: F | undefined) => void;
}
export declare function createSpawnTurnTracker<F extends TurnFrameLike>(agentName: string, input: TurnInputLike, onOutput: ((frame: F) => Promise<void>) | undefined): SpawnTurnTracker<F>;
export {};

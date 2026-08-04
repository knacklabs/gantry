import { type SpawnTurnTracker } from './spawn-turn-tracker.js';
interface SpawnLogTurnInput {
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
interface SpawnLogFrame {
    status: string;
    result: string | null;
    error?: string;
    continuedByFollowup?: boolean;
}
export declare function runSpawnWithLogContext<Frame extends SpawnLogFrame>(input: {
    agentName: string;
    turn: SpawnLogTurnInput;
    correlationRunId?: string;
    appId: string;
    agentId: string;
    onOutput: ((output: Frame) => Promise<void>) | undefined;
}, run: (tracker: SpawnTurnTracker<Frame>) => Promise<Frame>): Promise<Frame>;
export {};

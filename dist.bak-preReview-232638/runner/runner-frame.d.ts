import type { NormalizedModelUsage, RuntimeContextUsageSnapshot } from '../shared/model-catalog.js';
export declare const OUTPUT_START_MARKER = "---GANTRY_OUTPUT_START---";
export declare const OUTPUT_END_MARKER = "---GANTRY_OUTPUT_END---";
export interface RunnerRuntimeEventFrame {
    appId?: string;
    agentId?: string;
    runId?: string;
    jobId?: string;
    conversationId?: string;
    threadId?: string;
    eventType: string;
    actor?: string;
    responseMode?: 'sse' | 'webhook' | 'both' | 'none';
    payload: unknown;
}
export interface RunnerOutputFrame {
    status: 'success' | 'error';
    result: string | null;
    newSessionId?: string;
    sessionInit?: boolean;
    runtimeEventOnly?: boolean;
    compactBoundary?: boolean;
    interactionBoundary?: 'user_interaction';
    continuedByFollowup?: boolean;
    usage?: NormalizedModelUsage;
    usageEventId?: string;
    contextUsage?: RuntimeContextUsageSnapshot;
    error?: string;
    runtimeEvents?: RunnerRuntimeEventFrame[];
}
export declare function writeRunnerFrame(frame: RunnerOutputFrame): void;
export declare function readRunnerStdin(): Promise<string>;

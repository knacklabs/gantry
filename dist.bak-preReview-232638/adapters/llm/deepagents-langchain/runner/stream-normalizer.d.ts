import type { NormalizedCacheProvider, NormalizedModelUsage, RuntimeContextUsageSnapshot } from '../../../../shared/model-catalog.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import { type TaskLifecycleContext, type TaskLifecycleEventInput } from '../../../../runner/task-lifecycle-events.js';
export interface LangGraphStreamEvent {
    event: string;
    name?: string;
    data?: {
        chunk?: unknown;
        output?: unknown;
    };
}
export declare function buildGantryTaskLifecycleStreamEvent(input: TaskLifecycleEventInput): LangGraphStreamEvent;
export interface ModelProfileSnapshot {
    maxInputTokens?: number;
    maxOutputTokens?: number;
}
export interface StreamNormalizerInput {
    events: AsyncIterable<LangGraphStreamEvent>;
    newSessionId: string;
    modelId?: string;
    modelProfile: ModelProfileSnapshot;
    cacheProvider?: NormalizedCacheProvider;
    emit: (frame: RunnerOutputFrame) => void;
    onFirstEvent?: (eventName: string) => void;
    onFirstVisibleText?: () => void;
    onToolStart?: (toolName: string) => void;
    runtimeEventContext?: TaskLifecycleContext;
}
interface UsageAccumulator {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export interface NormalizedTurnResult {
    text: string;
    usage: UsageAccumulator;
    terminalResult: string | null;
    terminalUsage: NormalizedModelUsage;
    terminalContextUsage: RuntimeContextUsageSnapshot;
}
export declare function normalizeDeepAgentStream(input: StreamNormalizerInput): Promise<NormalizedTurnResult>;
export {};

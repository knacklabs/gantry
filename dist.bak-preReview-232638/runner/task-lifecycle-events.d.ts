import type { RunnerRuntimeEventFrame } from './runner-frame.js';
export type TaskLifecycleEventKind = 'started' | 'progress' | 'updated' | 'notification';
export type GantryTaskKind = 'async_command' | 'delegated_agent';
export type GantryTaskStatus = 'queued' | 'running' | 'needs_attention' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export interface TaskLifecycleContext {
    appId?: string;
    agentId?: string;
    runId?: string;
    jobId?: string;
    conversationId?: string;
    threadId?: string;
    actor?: string;
}
export interface TaskLifecycleUsageInput {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
}
export interface TaskLifecyclePatchInput {
    status?: string;
    description?: string;
    endTime?: number;
    totalPausedMs?: number;
    isBackgrounded?: boolean;
    hasError?: boolean;
}
export interface TaskLifecycleEventInput {
    kind: TaskLifecycleEventKind;
    taskId: string;
    toolUseId?: string;
    description?: string;
    subagentType?: string;
    taskKind?: GantryTaskKind;
    taskType?: string;
    workflowName?: string;
    skipTranscript?: boolean;
    lastToolName?: string;
    summary?: string;
    status?: string;
    usage?: TaskLifecycleUsageInput;
    patch?: TaskLifecyclePatchInput;
}
export declare function buildTaskLifecycleRuntimeEvent(context: TaskLifecycleContext, input: TaskLifecycleEventInput): RunnerRuntimeEventFrame | null;

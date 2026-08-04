import { type TaskResponseEnvelope } from '../ipc.js';
export declare const SCHEDULER_WAIT_RESPONSE_GRACE_MS = 10000;
export declare function requestSchedulerData(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<TaskResponseEnvelope | null>;
export declare function normalizeSchedulerWaitTimeoutMs(value: unknown): number;
export declare function schedulerTaskError(response: TaskResponseEnvelope | null, fallback: string): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | null;
type SchedulerMutationResult = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
};
export declare function submitSchedulerMutationTask(input: {
    taskType: string;
    taskId: string;
    payload: Record<string, unknown>;
    timeoutText: string;
    rejectedText: string;
    successText: string;
    timeoutMs?: number;
}): Promise<SchedulerMutationResult>;
export declare function schedulerDataRecord(response: TaskResponseEnvelope): Record<string, unknown>;
export declare function canonicalTargetFromArgs(args: Record<string, unknown>, useAmbientDefault: boolean): {
    executionContext: {
        conversationJid: string;
        threadId: string | null;
        workspaceKey: string;
        sessionId?: string | null;
    };
    notificationRoutes: Array<{
        conversationJid: string;
        threadId: string | null;
        label: string;
    }>;
    error?: string;
};
export {};

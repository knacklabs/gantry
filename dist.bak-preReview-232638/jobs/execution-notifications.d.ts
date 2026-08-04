import type { Job, JobSetupState, JobRunStatus } from '../domain/types.js';
import type { SchedulerSendMessage } from './delivery.js';
type TerminalRunStatus = Extract<JobRunStatus, 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered'>;
export type JobNotificationLifecycleUpdateResult = 'updated' | 'unsupported' | 'failed';
export declare function logMemoryDreamJobFailure(input: {
    job: Job;
    runId: string;
    error: string | null;
    logger: {
        error(payload: Record<string, unknown>, message: string): void;
    };
}): void;
export declare function notifySchedulerRunRecovered(input: {
    job: Job;
    runId: string;
    sendMessage: SchedulerSendMessage;
}): Promise<boolean>;
export declare function notifySchedulerSetupRequired(input: {
    job: Job;
    setupState: JobSetupState;
    sendMessage: SchedulerSendMessage;
}): Promise<boolean>;
export declare function notifySchedulerTerminalRunState(input: {
    job: Job;
    runId: string;
    runShortId?: number | null;
    runStatus: TerminalRunStatus;
    summary: string;
    nextRun: string | null;
    retryCount: number;
    pauseReason: string | null;
    durationMs?: number;
    sendMessage: SchedulerSendMessage;
    updateLifecycleNotification?: (input: {
        job: Job;
        runId: string;
        runStatus: TerminalRunStatus;
        summaryMessage: string;
    }) => Promise<JobNotificationLifecycleUpdateResult>;
}): Promise<boolean>;
export {};

import type { Job } from '../domain/types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
export declare function publishSchedulerRunCompletion(input: {
    currentJob: Job;
    runId: string;
    runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
    notified: boolean;
    startNotified: boolean;
    summary: string;
    nextRun: string | null;
    boundTriggerId?: string;
    eventAppSession?: SchedulerEventAppSession;
    resolveEventAppSession: () => Promise<SchedulerEventAppSession | undefined>;
    markTriggerCompleted: (status: 'completed' | 'failed') => Promise<void> | void;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<void> | void;
    runtimeAppId: string;
    logger: {
        warn(payload: Record<string, unknown>, message: string): void;
    };
}): Promise<SchedulerEventAppSession | undefined>;

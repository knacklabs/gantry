import type { Job } from '../domain/types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { type RuntimeEventType } from '../domain/events/runtime-event-types.js';
import { type SchedulerEventAppSession } from './app-session-resolution.js';
import type { SchedulerDispatchPayload } from './types.js';
interface RuntimeControlEventRepository {
    bindTriggerToRun(triggerId: string, runId: string): Promise<{
        triggerId: string;
        requestedBy: string;
    } | null | undefined>;
    bindPendingTriggerToRun(jobId: string, runId: string): Promise<{
        triggerId: string;
        requestedBy: string;
    } | null | undefined>;
    getAppSessionById(sessionId: string): Promise<SchedulerEventAppSession | null | undefined>;
    markTriggerCompleted(triggerId: string, status: 'completed' | 'failed'): Promise<void>;
}
export interface SchedulerRunEventState {
    boundTriggerId?: string;
    eventAppSession?: SchedulerEventAppSession;
}
export declare function createRuntimeEventPublisher(input: {
    publish(event: RuntimeEventPublishInput): Promise<unknown>;
}): (event: RuntimeEventPublishInput) => Promise<void>;
export declare function bindSchedulerRunEventState(input: {
    currentJob: Job;
    dispatch?: SchedulerDispatchPayload;
    runId: string;
    runShortId: number | null;
    scheduledFor: string;
    runtimeAppId: string;
    control: RuntimeControlEventRepository;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
    logger: {
        warn(context: Record<string, unknown>, message: string): void;
    };
}): Promise<SchedulerRunEventState>;
export declare function createSchedulerJobEventEmitter(input: {
    currentJob: Job;
    runId: string;
    runtimeAppId: string;
    state: SchedulerRunEventState;
    resolveEventAppSession: () => Promise<SchedulerEventAppSession>;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
    deletionGuard: {
        isJobDeleted(force?: boolean): Promise<boolean>;
    };
    logger: {
        warn(context: Record<string, unknown>, message: string): void;
    };
}): (eventType: RuntimeEventType, payload: Record<string, unknown> | null) => Promise<void>;
export declare function publishSchedulerCompletionEvent(input: {
    currentJob: Job;
    runId: string;
    runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
    notified: boolean;
    startNotified: boolean;
    summary: string;
    nextRun: string | null;
    state: SchedulerRunEventState;
    runtimeAppId: string;
    control: RuntimeControlEventRepository;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
    logger: {
        warn(context: Record<string, unknown>, message: string): void;
    };
}): Promise<void>;
export {};

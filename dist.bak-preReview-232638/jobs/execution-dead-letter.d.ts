import type { Job } from '../domain/types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { type SchedulerEventAppSession } from './app-session-resolution.js';
import type { SchedulerDependencies, SchedulerDispatchPayload } from './types.js';
interface SchedulerDeadLetterControl {
    bindTriggerToRun(triggerId: string, runId: string): Promise<{
        triggerId: string;
        requestedBy: string;
    } | undefined>;
    bindPendingTriggerToRun(jobId: string, runId: string): Promise<{
        triggerId: string;
        requestedBy: string;
    } | undefined>;
    getAppSessionById(sessionId: string): Promise<SchedulerEventAppSession | null | undefined>;
    markTriggerCompleted(triggerId: string, status: 'completed' | 'failed'): Promise<void> | void;
}
interface SchedulerDeadLetterLogger {
    warn(payload: Record<string, unknown>, message: string): void;
}
/**
 * Resolves the job's execution context, dead-lettering the job when no
 * conversation route can satisfy it. Returns undefined after dead-lettering.
 */
export declare function resolveExecutionContextOrDeadLetter<Execution>(input: Parameters<typeof deadLetterUnresolvedExecutionContext>[0] & {
    resolve: () => Execution | undefined;
}): Promise<Execution | undefined>;
export declare function deadLetterUnresolvedExecutionContext(input: {
    currentJob: Job;
    deps: SchedulerDependencies;
    runId: string;
    scheduledFor: string;
    startedAt: string;
    startedAtMs: number;
    dispatch?: SchedulerDispatchPayload;
    runtimeAppId: string;
    control: SchedulerDeadLetterControl;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<void> | void;
    logger: SchedulerDeadLetterLogger;
}): Promise<void>;
export {};

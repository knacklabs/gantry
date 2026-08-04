import type { Job } from '../domain/types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { JobRecoveryIntentSource } from '../application/jobs/job-recovery-intent-service.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import type { SchedulerDependencies } from './types.js';
export declare function pauseJobForSetupIfNeeded(input: {
    currentJob: Job;
    deps: SchedulerDependencies;
    executionAgentFolder: string;
    runtimeAppId: string;
    appSession?: SchedulerEventAppSession;
    agentId?: string;
    source?: JobRecoveryIntentSource;
    runId?: string | null;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<boolean>;
export declare function notifyJobSetupRequired(input: {
    currentJob: Job;
    deps: SchedulerDependencies;
    runtimeAppId: string;
    appSession?: SchedulerEventAppSession;
    setupState: NonNullable<Job['setup_state']>;
    source?: JobRecoveryIntentSource;
    runId?: string | null;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<boolean>;

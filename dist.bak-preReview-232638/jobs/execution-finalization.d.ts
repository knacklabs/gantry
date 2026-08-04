import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { Job } from '../domain/types.js';
import { parseAutonomousToolDenial } from '../shared/autonomous-tool-denial.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import { type JobRunDiagnostics } from './execution-diagnostics.js';
import type { SchedulerDependencies } from './types.js';
export type SchedulerRunStatus = 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
export interface FinalizedJobRunState {
    runStatus: SchedulerRunStatus;
    nextRun: string | null;
    retryCount: number;
    pauseReason: string | null;
    safeErrorSummary: string | null;
    toolDenial: ReturnType<typeof parseAutonomousToolDenial>;
}
export declare function finalizeSchedulerJobRun(input: {
    currentJob: Job;
    deps: SchedulerDependencies;
    scheduledFor: string;
    now: string;
    error: string | null;
    diagnostics: JobRunDiagnostics;
    pausedForSetupDuringRun: boolean;
    setupStateForSetupPause?: NonNullable<Job['setup_state']>;
    deletedDuringRun: boolean;
    runtimeAppId: string;
    runId: string;
    appSession?: SchedulerEventAppSession;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
    beforeJobStateUpdate?: (state: FinalizedJobRunState) => Promise<void>;
    updateJobState?: (updates: Partial<Job>, state: FinalizedJobRunState) => Promise<void>;
}): Promise<FinalizedJobRunState>;
export declare function retryBackoffMs(job: Job, retryCount: number): number;

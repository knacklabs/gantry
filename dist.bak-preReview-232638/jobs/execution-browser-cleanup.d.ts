import { type RuntimeEventType } from '../domain/events/runtime-event-types.js';
import type { Job } from '../domain/types.js';
import { type JobRunDiagnostics } from './execution-diagnostics.js';
import type { SchedulerDependencies } from './types.js';
export declare function closeBrowserAfterJobRun(input: {
    currentJob: Job;
    executionGroupFolder?: string;
    executionJid?: string;
    diagnostics: JobRunDiagnostics;
    deps: SchedulerDependencies;
    snapshotRunId?: string | null;
    snapshotFencingVersion?: number;
    emitJobEvent: (eventType: RuntimeEventType, payload: Record<string, unknown>) => Promise<void>;
    logger: {
        warn: (context: Record<string, unknown>, message: string) => void;
    };
}): Promise<void>;

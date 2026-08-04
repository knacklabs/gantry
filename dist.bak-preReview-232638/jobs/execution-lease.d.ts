import type { RunLease, RunLeaseRepository, RunnerControlEventRepository, RunnerControlEventType } from '../domain/ports/worker-coordination.js';
import type { Job } from '../domain/types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { SchedulerDependencies } from './types.js';
type WarnLog = (context: Record<string, unknown>, message: string) => void;
export declare const RUNNER_CONTROL_EVENT_WRITE_TIMEOUT_MS = 5000;
export type RecordRunnerControlEvent = (eventType: RunnerControlEventType, payload: Record<string, unknown>) => Promise<void>;
export interface SchedulerRunLeaseContext {
    lease: RunLease;
    recordRunnerControlEvent: RecordRunnerControlEvent;
}
export interface SchedulerRunLeaseHeartbeat {
    stop(): void;
}
export declare const SCHEDULER_RUN_LEASE_LOST_ERROR = "Scheduler run stopped because its lease was lost.";
export declare function createSchedulerRunLeaseAbort(): {
    signal: AbortSignal;
    error: string;
    abort: () => void;
    isAborted: () => boolean;
    errorFor: (err: unknown) => string;
};
/**
 * Worker claim step: the run executes only with a confirmed lease. Persists
 * the 'claimed' runner-control event and, when a previous active lease was
 * expired/recovered, sends the run-recovered notification.
 */
export declare function claimSchedulerRunLease(input: {
    deps: SchedulerDependencies;
    currentJob: Job;
    runId: string;
    executionProviderId: ExecutionProviderId;
    workerId: string;
    leaseOwner: string;
    scheduledFor: string;
    startedAt: string;
    leaseExpiresAt: string;
    requireNextRun: boolean;
    getCoordinationRepository: () => RunnerControlEventRepository;
    warn: WarnLog;
}): Promise<SchedulerRunLeaseContext | null>;
export declare function startSchedulerRunLeaseHeartbeat(input: {
    runId: string;
    leaseContext: SchedulerRunLeaseContext;
    ttlMs: number;
    deadlineMs?: number;
    getCoordinationRepository: () => Pick<RunLeaseRepository, 'heartbeatRunLease'>;
    warn: WarnLog;
    onLeaseLost?: () => void;
    externalAbortSignal?: AbortSignal;
}): SchedulerRunLeaseHeartbeat;
/**
 * Lease-fenced settlement: terminal writes require this worker's lease
 * coordinates to still be the run's active lease. Returns false when the run
 * was recovered by another worker — the caller must drop all terminal writes.
 */
export declare function settleSchedulerRunLease(input: {
    deps: SchedulerDependencies;
    currentJob: Job;
    runId: string;
    leaseContext: SchedulerRunLeaseContext;
    error: string | null;
    warn: WarnLog;
}): Promise<boolean>;
export {};

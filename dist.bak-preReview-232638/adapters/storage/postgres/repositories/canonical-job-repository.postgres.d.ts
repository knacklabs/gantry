import type { JobRun } from '../../../../domain/repositories/domain-types.js';
import type { JobListFilters, JobRunListFilters, ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import type { RuntimeEventType } from '../../../../domain/events/runtime-event-types.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import { type RunLeaseFence } from './run-lease-fence.postgres.js';
export interface CanonicalJobRecord {
    id: string;
    agentId: string | null;
    name: string;
    prompt: string;
    model: string | null;
    scheduleJson: string;
    status: string;
    targetJson: string;
    silent: boolean;
    timeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    leaseRunId: string | null;
    leaseExpiresAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface JobRecordInput {
    id: string;
    agentId: string;
    name: string;
    prompt: string;
    model: string | null;
    scheduleJson: string;
    status: string;
    targetJson: string;
    silent: boolean;
    timeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    leaseRunId: string | null;
    leaseExpiresAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface CanonicalRunRecord {
    id: string;
    shortId: number | null;
    jobId: string | null;
    executionProviderId: string;
    providerRunId: string | null;
    providerSessionId: string | null;
    workerId: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    status: string;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
    resultSummary: string | null;
    errorSummary: string | null;
    notifiedAt: string | null;
}
export interface CanonicalJobTerminalUpdate {
    status?: string;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    leaseRunId?: string | null;
    leaseExpiresAt?: string | null;
    updatedAt: string;
    targetJsonPatch?: Record<string, unknown>;
}
export interface CanonicalJobEventRecord {
    id: string;
    appId: string;
    runId: string;
    jobId: string;
    type: string;
    payloadJson: string;
    createdAt: string;
}
export declare class PostgresCanonicalJobRepository {
    private readonly db;
    private readonly graph;
    constructor(db: CanonicalDb);
    findJobById(id: string): Promise<CanonicalJobRecord | undefined>;
    listJobs(filters?: JobListFilters): Promise<CanonicalJobRecord[]>;
    upsertJob(record: JobRecordInput): Promise<void>;
    updateJob(id: string, record: Omit<JobRecordInput, 'id' | 'createdAt'>): Promise<void>;
    deleteJob(id: string): Promise<void>;
    claimDueRunStart(input: {
        jobId: string;
        run: JobRun;
        leaseExpiresAt: string;
        workerInstanceId: string;
        requireNextRun?: boolean;
    }): Promise<RunLease | null>;
    settleRunLease(input: {
        runId: string;
        leaseToken: string;
        outcome: 'completed' | 'failed' | 'released';
        allowAlreadySettled?: boolean;
    }): Promise<boolean>;
    releaseStaleLeases(nowIso?: string): Promise<ReleasedStaleJobLease[]>;
    insertRun(run: JobRun, executor?: CanonicalDb | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0]): Promise<boolean>;
    updateRunCompletion(runId: string, input: {
        status: JobRun['status'];
        endedAt: string;
        resultSummary: string | null;
        errorSummary: string | null;
    }): Promise<void>;
    updateRunCompletionWithLease(runId: string, input: {
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        status: JobRun['status'];
        endedAt: string;
        resultSummary: string | null;
        errorSummary: string | null;
    }): Promise<boolean>;
    finalizeRunCompletionWithLease(input: {
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        leaseOutcome: 'completed' | 'failed' | 'released';
        runCompletion: {
            status: JobRun['status'];
            endedAt: string;
            resultSummary: string | null;
            errorSummary: string | null;
        };
    }): Promise<boolean>;
    finalizeRunWithLease(input: {
        jobId: string;
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        leaseOutcome: 'completed' | 'failed' | 'released';
        runCompletion: {
            status: JobRun['status'];
            endedAt: string;
            resultSummary: string | null;
            errorSummary: string | null;
        };
        jobUpdate: CanonicalJobTerminalUpdate;
    }): Promise<boolean>;
    updateRunProviderMetadata(runId: string | readonly string[], input: {
        fenceRunId?: string;
        leaseToken?: string;
        workerInstanceId?: string;
        fencingVersion?: number;
        providerRunId?: string | null;
        providerSessionId?: string | null;
    }): Promise<boolean>;
    markRunNotified(runId: string, notifiedAt: string, lease?: RunLeaseFence): Promise<boolean>;
    findRunById(runId: string): Promise<CanonicalRunRecord | undefined>;
    listRuns(jobId?: string, limit?: number, filters?: JobRunListFilters): Promise<CanonicalRunRecord[]>;
    listLatestJobRunsByJobIds(jobIds: readonly string[]): Promise<CanonicalRunRecord[]>;
    private listRunsForOwnerApp;
    listDeadLetterRuns(limit?: number): Promise<CanonicalRunRecord[]>;
    findRuntimeEventAppIdForRun(runId: string): Promise<string | undefined>;
    listEvents(limit?: number, filters?: {
        appId?: string;
        jobId?: string;
        jobIds?: string[];
        ownerAppId?: string;
        runId?: string;
        eventType?: RuntimeEventType;
        sinceId?: number;
        since?: string;
    }): Promise<CanonicalJobEventRecord[]>;
    private listEventsForOwnerApp;
    private ensureJobRunGraph;
    private nextRunShortId;
    private ensureAgentForRecord;
}

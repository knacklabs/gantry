import type { Job, JobEvent, JobRun } from '../../../../domain/repositories/domain-types.js';
import type { JobEventListFilters, JobListFilters, JobRunListFilters, JobUpsertInput, ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import type { ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
import type { PostgresCanonicalJobRepository } from '../repositories/canonical-job-repository.postgres.js';
export declare class CanonicalJobOpsService {
    private readonly repository;
    constructor(repository: PostgresCanonicalJobRepository);
    upsertJob(job: JobUpsertInput): Promise<{
        created: boolean;
    }>;
    getJobById(id: string): Promise<Job | undefined>;
    getAllJobs(): Promise<Job[]>;
    listJobs(filters?: JobListFilters): Promise<Job[]>;
    updateJob(id: string, updates: Partial<Job>): Promise<void>;
    deleteJob(id: string): Promise<void>;
    deleteExpiredCompletedOneTimeJobs(nowIso?: string): Promise<number>;
    claimDueJobRunStart(input: {
        jobId: string;
        runId: string;
        executionProviderId: ExecutionProviderId;
        workerId?: string | null;
        leaseOwner?: string | null;
        workerInstanceId: string;
        scheduledFor: string;
        startedAt: string;
        retryCount: number;
        leaseExpiresAt: string;
        requireNextRun?: boolean;
    }): Promise<RunLease | null>;
    releaseStaleJobLeases(nowIso?: string): Promise<ReleasedStaleJobLease[]>;
    settleJobRunLease(input: {
        runId: string;
        leaseToken: string;
        outcome: 'completed' | 'failed' | 'released';
        allowAlreadySettled?: boolean;
    }): Promise<boolean>;
    createJobRun(run: JobRun): Promise<boolean>;
    updateAgentRunProviderMetadata(input: {
        runId: string;
        runIds?: string[];
        fenceRunId?: string;
        leaseToken?: string;
        workerInstanceId?: string;
        fencingVersion?: number;
        providerRunId?: string | null;
        providerSessionId?: string | null;
    }): Promise<boolean>;
    getRecentJobRuns(limit?: number): Promise<JobRun[]>;
    completeJobRun(runId: string, status: JobRun['status'], resultSummary?: string | null, errorSummary?: string | null): Promise<void>;
    completeJobRunWithLease(input: {
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        status: JobRun['status'];
        resultSummary?: string | null;
        errorSummary?: string | null;
    }): Promise<boolean>;
    finalizeJobRunLease(input: {
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        leaseOutcome: 'completed' | 'failed' | 'released';
        runStatus: JobRun['status'];
        resultSummary?: string | null;
        errorSummary?: string | null;
    }): Promise<boolean>;
    finalizeJobRunWithLease(input: {
        jobId: string;
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        leaseOutcome: 'completed' | 'failed' | 'released';
        runStatus: JobRun['status'];
        resultSummary?: string | null;
        errorSummary?: string | null;
        jobUpdates: Partial<Job>;
    }): Promise<boolean>;
    markJobRunNotified(runId: string, lease?: {
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
    }): Promise<boolean>;
    getJobRunById(runId: string): Promise<JobRun | undefined>;
    listJobRuns(jobId?: string, limit?: number, filters?: JobRunListFilters): Promise<JobRun[]>;
    listLatestJobRunsByJobIds(jobIds: readonly string[]): Promise<Map<string, JobRun>>;
    listDeadLetterRuns(limit?: number): Promise<JobRun[]>;
    listRecentJobEvents(limit?: number, filters?: JobEventListFilters): Promise<JobEvent[]>;
    private resolveEventQueryAppId;
    private rowToJob;
    private toRecordInput;
    private toTerminalJobUpdate;
    private mapRun;
    private mapEvent;
}

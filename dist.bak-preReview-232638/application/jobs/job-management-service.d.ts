import type { Job, JobManagementServiceDeps, SchedulerJobAccess, SchedulerRunNowInput, CreateManagedJobInput, UpsertJobFromIpcInput, ManagedJobListInput, ManagedJobLookupInput, ManagedJobUpdateInput, ManagedJobDeleteInput, ManagedJobPauseInput, ManagedJobResumeInput, ManagedJobTriggerInput, ManagedJobTriggerWaitInput } from './job-management-types.js';
export declare class JobManagementService {
    private readonly deps;
    constructor(deps: JobManagementServiceDeps);
    createJob(input: CreateManagedJobInput): Promise<{
        jobId: string;
        created: boolean;
        modelAlias: string | undefined;
        runtimeContext: {
            sessionId: string;
            conversationJid: string;
            workspaceKey: string;
            threadId: string | null;
        };
        setupState: import("../../domain/job-types.js").JobSetupState;
        status: string;
        pauseReason: string | null;
    } | {
        jobId: string;
        created: boolean;
        modelAlias: string | undefined;
        runtimeContext: {
            sessionId: string;
            conversationJid: string;
            workspaceKey: string;
            threadId: string | null;
        };
        setupState: import("../../domain/job-types.js").JobSetupState;
        status?: undefined;
        pauseReason?: undefined;
    }>;
    upsertJobFromIpc(input: UpsertJobFromIpcInput): Promise<{
        jobId: string;
        created: boolean;
        modelAlias: string | undefined;
        status: import("../../domain/job-types.js").JobStatus;
        setupState: import("../../domain/job-types.js").JobSetupState;
        pauseReason: string | null | undefined;
    }>;
    listJobs(input: ManagedJobListInput): Promise<{
        jobs: Job[];
    }>;
    getJob(input: ManagedJobLookupInput): Promise<{
        job: Job | null;
    }>;
    updateJob(input: ManagedJobUpdateInput): Promise<{
        job: Job;
    }>;
    deleteJob(input: ManagedJobDeleteInput): Promise<{
        deleted: true;
    }>;
    pauseJob(input: ManagedJobPauseInput): Promise<{
        paused: true;
    }>;
    resumeJob(input: ManagedJobResumeInput): Promise<{
        resumed: boolean;
        job: Job;
    }>;
    triggerJob(input: ManagedJobTriggerInput): Promise<{
        triggerId: string;
    }>;
    runJobNowFromMcp(input: SchedulerRunNowInput): Promise<{
        runId: string;
        queued: true;
        triggerId: string;
    }>;
    waitForTrigger(input: ManagedJobTriggerWaitInput): Promise<{
        triggerId: string;
        runId: string;
        status: string;
        resultSummary: string | null;
        errorSummary: string | null;
    }>;
    listJobRuns(input: {
        appId?: string;
        access?: SchedulerJobAccess;
        jobId?: string;
        limit?: number;
    }): Promise<{
        runs: import("./job-management-types.js").JobRun[];
    }>;
    listJobEvents(input: {
        appId?: string;
        access?: SchedulerJobAccess;
        jobId?: string;
        runId?: string;
        eventType?: string;
        sinceId?: number;
        since?: string;
        limit?: number;
    }): Promise<{
        events: import("./job-management-types.js").JobEvent[];
    }>;
    listDeadLetterRuns(input: {
        appId?: string;
        access?: SchedulerJobAccess;
        limit?: number;
    }): Promise<{
        deadLetterRuns: import("./job-management-types.js").JobRun[];
    }>;
    private requireJob;
    private assertAccess;
    private clock;
    private visibilityReaders;
}

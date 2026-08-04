import type { Job, JobManagementServiceDeps, JobUpdatePatch, SchedulerJobAccess } from './job-management-types.js';
export declare function resolveAuthenticatedRouteContextForUpdate(input: {
    deps: JobManagementServiceDeps;
    job: Job;
    appId?: string;
    access?: SchedulerJobAccess;
    workspaceKey: string;
    patchExecutionContext?: JobUpdatePatch['executionContext'];
}): Promise<{
    conversationJid: string;
    threadId: string | null;
    workspaceKey: string;
} | null>;
export declare function assertJobAppAccess(input: {
    deps: JobManagementServiceDeps;
    job: Job;
    appId: string;
}): Promise<void>;

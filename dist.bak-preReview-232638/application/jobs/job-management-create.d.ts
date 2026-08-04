import type { CreateManagedJobInput, JobManagementServiceDeps } from './job-management-types.js';
export declare function createManagedJob(deps: JobManagementServiceDeps, input: CreateManagedJobInput): Promise<{
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

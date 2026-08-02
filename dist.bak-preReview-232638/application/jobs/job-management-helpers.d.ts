import type { Job, JobScheduleType } from '../../domain/types.js';
import type { Clock } from '../common/clock.js';
import type { AppSessionRecord, JobExecutionContextInput, JobNotificationRouteInput, JobControlPort, JobSchedulePlanner, JobUpdatePatch, SchedulerJobAccess } from './job-management-types.js';
export interface AuthenticatedJobRouteContext {
    conversationJid: string;
    threadId: string | null;
    workspaceKey: string;
    providerAccountId?: string | null;
}
export interface JobNotificationRouteApprovalDecision {
    approved: boolean;
    reason?: string;
    approvedConversationJid?: string;
}
export interface JobNotificationRouteApprovalRequest {
    operation: 'create' | 'update';
    jobId: string;
    jobName: string;
    authenticatedContext: AuthenticatedJobRouteContext;
    requestedRoutes: JobNotificationRouteInput[];
    existingRoutes: JobNotificationRouteInput[];
    routesBeyondContext: JobNotificationRouteInput[];
}
export interface JobNotificationRouteApprovalDeps {
    approveJobNotificationRoutes?: (input: JobNotificationRouteApprovalRequest) => Promise<JobNotificationRouteApprovalDecision>;
}
export declare function resolveCanonicalAppSessionForOrigin(input: {
    access: SchedulerJobAccess;
    control?: JobControlPort;
}): Promise<{
    originAppId: string | null;
    canonicalSession?: AppSessionRecord;
}>;
export declare function normalizeScheduleType(raw: unknown): JobScheduleType;
export declare function assertPublicJobNamespace(input: {
    jobId?: string | null;
    prompt?: string | null;
}): void;
export declare function resolveLimit(raw: unknown, fallback: number): number;
export declare function normalizeExecutionContext(value: JobExecutionContextInput): JobExecutionContextInput;
export declare function authenticatedContextFromAccess(access: SchedulerJobAccess, workspaceKey: string): AuthenticatedJobRouteContext;
export declare function assertExecutionContextMatchesAuthenticatedContext(input: {
    executionContext?: JobExecutionContextInput;
    authenticatedContext: AuthenticatedJobRouteContext;
    enforceThread?: boolean;
}): JobExecutionContextInput;
export declare function normalizeNotificationRoutes(routes: readonly JobNotificationRouteInput[]): JobNotificationRouteInput[];
export declare function normalizeStoredNotificationRoutes(routes: readonly JobNotificationRouteInput[] | undefined): JobNotificationRouteInput[];
export declare function routesBeyondAuthenticatedContext(input: {
    routes: readonly JobNotificationRouteInput[];
    authenticatedContext: AuthenticatedJobRouteContext;
}): JobNotificationRouteInput[];
export declare function requireJobNotificationRouteApproval(input: {
    deps: JobNotificationRouteApprovalDeps;
    request: JobNotificationRouteApprovalRequest;
}): Promise<void>;
export declare function buildJobUpdates(job: Job, patch: JobUpdatePatch, planner: JobSchedulePlanner, clock: Clock): Partial<Job>;
export declare function encodeTriggerRequester(input: {
    appId: string;
    sessionId: string;
}): string;

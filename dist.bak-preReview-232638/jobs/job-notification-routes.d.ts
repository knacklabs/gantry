import type { JobExecutionContext, JobNotificationRoute } from '../domain/types.js';
export declare const JOB_NOTIFICATION_START_PROFILE_ID = "job.notification.start.v1";
export declare const JOB_NOTIFICATION_SUMMARY_PROFILE_ID = "job.notification.summary.v1";
export type JobNotificationPhase = 'start' | 'summary';
export interface NormalizedJobNotificationRoute {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string;
    label: string;
}
export interface JobNotificationRouteSource {
    notification_routes?: readonly JobNotificationRoute[] | null;
    notificationRoutes?: readonly JobNotificationRoute[] | null;
    execution_context?: JobExecutionContext | null;
    executionContext?: JobExecutionContext | null;
}
export declare function resolveJobNotificationRoutes(source: JobNotificationRouteSource): NormalizedJobNotificationRoute[];
export declare function profileIdForJobNotificationPhase(phase: JobNotificationPhase): string;
export declare function buildJobNotificationIdempotencyKey(input: {
    jobId: string;
    runId?: string | null;
    phase: JobNotificationPhase;
    route: Pick<NormalizedJobNotificationRoute, 'conversationJid' | 'threadId' | 'providerAccountId'>;
}): string;
export declare function buildCanonicalJobLifecycleTarget(input: {
    conversationJid: string;
    threadId?: string | null;
    workspaceKey: string;
    sessionId?: string | null;
    providerAccountId?: string | null;
    label?: string;
}): {
    executionContext: JobExecutionContext;
    notificationRoutes: JobNotificationRoute[];
};

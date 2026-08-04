export interface SchedulerJobAccessRequirementImplementation {
    kind: 'configured_access' | 'local_cli' | 'mcp_server' | 'builtin_tool';
    name?: string;
    executablePath?: string;
    executableVersion?: string;
    executableHash?: string;
    commandTemplate?: string;
    authPreflight?: string;
    protectedPaths?: string[];
    networkHosts?: string[];
}
export type SchedulerJobAccessRequirementTarget = {
    kind: 'tool_rule';
    rule: string;
} | {
    kind: 'capability';
    capabilityId: string;
    implementation?: SchedulerJobAccessRequirementImplementation;
} | {
    kind: 'mcp_server';
    server: string;
};
export interface SchedulerJobAccessRequirement {
    target: SchedulerJobAccessRequirementTarget;
    reason?: string;
}
export interface SchedulerJobPlanInput {
    jobId?: string | null;
    name: string;
    prompt: string;
    modelAlias?: string | null;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    executionContext?: {
        conversationJid: string;
        threadId: string | null;
        workspaceKey: string;
        sessionId?: string | null;
    };
    notificationRoutes?: Array<{
        conversationJid: string;
        threadId: string | null;
        label: string;
    }>;
    accessRequirements?: SchedulerJobAccessRequirement[];
    silent?: boolean;
    cleanupAfterMs?: number;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    maxConsecutiveFailures?: number;
    createdBy?: 'agent' | 'human';
}
export declare function schedulerJobConfirmationToken(input: SchedulerJobPlanInput): string;
export declare function formatSchedulerJobPlan(input: SchedulerJobPlanInput & {
    confirmationToken?: string;
    modelDescription?: string;
    runtimeDescription?: string;
}): string;

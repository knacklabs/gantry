import type { Job, JobCapabilityRequirement } from '../../domain/types.js';
import type { SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type { JobExecutionContextInput, JobNotificationRouteInput } from './job-management-types.js';
import { type SchedulerJobStaleness } from '../../shared/scheduler-job-staleness.js';
import { type JobToolAccessView } from '../../shared/tool-access-view.js';
export interface JobVisibilityMetadata {
    executionContext: JobExecutionContextInput;
    notificationRoutes: JobNotificationRouteInput[];
    target: {
        appId: string;
        agentId: string;
        workspaceKey: string;
        conversationJids: string[];
        threadId: string | null;
    };
    ownerLabel: string;
    deliveryLabel: string;
    setupLabel: string;
    nextActionLabel: string | null;
    promptPreview: string;
    fullPrompt?: string;
    inheritedTools: string[];
    effectiveAllowedTools: string[];
    capabilityRequirements: JobCapabilityRequirement[];
    toolAccessRequirements: string[];
    requiredMcpServers: string[];
    toolAccess: JobToolAccessView;
    setup: JobSetupMetadata;
    recovery: JobRecoveryMetadata;
    health: JobHealthMetadata;
    recentRunErrors: Array<{
        runId: string;
        status: string;
        errorSummary: string;
        endedAt: string | null;
    }>;
    staleness: SchedulerJobStaleness | null;
}
export interface JobHealthMetadata {
    state: 'ready' | 'missing_capability' | 'broker_unreachable' | 'credential_unknown' | 'browser_login_may_be_required' | 'mcp_missing_credential' | 'running' | 'completed' | 'failed' | 'needs_permission' | 'interrupted' | 'timed_out' | 'dead_lettered' | 'stale_lease' | 'missed_window';
    latestRunId: string | null;
    latestRunStatus: string | null;
    latestSummary: string | null;
    activeRunId: string | null;
    leaseExpiresAt: string | null;
    nextAction: string | null;
}
export interface JobSetupMetadata {
    state: NonNullable<Job['setup_state']>['state'];
    checkedAt: string | null;
    fingerprint: string | null;
    blockers: Array<{
        state: string;
        message: string;
        nextAction: string;
        requirementType: string;
        requirementId: string;
    }>;
    nextAction: string | null;
}
export interface JobRecoveryMetadata {
    state: NonNullable<Job['recovery_intent']>['state'] | 'none';
    kind: NonNullable<Job['recovery_intent']>['kind'] | null;
    updatedAt: string | null;
    attempts: number;
    requirementType: string | null;
    requirementId: string | null;
    nextAction: string | null;
    lastError: string | null;
}
export declare function buildJobVisibilityMetadata(input: {
    job: Job;
    ops: Pick<RuntimeJobRepository, 'listJobRuns'>;
    toolRepository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    appId?: string;
    recentRunLimit?: number;
    nowMs?: number;
}): Promise<JobVisibilityMetadata>;
export declare function buildJobListVisibilityMetadata(input: {
    jobs: Job[];
    ops?: Pick<RuntimeJobRepository, 'listLatestJobRunsByJobIds'>;
    toolRepository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    appId?: string;
    nowMs?: number;
}): Promise<Map<string, JobVisibilityMetadata>>;

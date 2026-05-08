import type { Job } from '../../domain/types.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type {
  JobExecutionContextInput,
  JobNotificationRouteInput,
} from './job-management-types.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import {
  agentIdForJobGroupScope,
  normalizeJobExtraTools,
  resolveAgentToolBindings,
  resolveJobToolPolicy,
} from './job-tool-policy.js';
import {
  schedulerJobStaleness,
  type SchedulerJobStaleness,
} from '../../shared/scheduler-job-staleness.js';
import {
  buildJobToolAccessView,
  type JobToolAccessView,
} from '../../shared/tool-access-view.js';

export interface JobVisibilityMetadata {
  executionContext: JobExecutionContextInput;
  notificationRoutes: JobNotificationRouteInput[];
  target: {
    appId: string;
    agentId: string;
    groupScope: string;
    conversationJids: string[];
    threadId: string | null;
  };
  promptPreview: string;
  fullPrompt?: string;
  inheritedTools: string[];
  jobExtraTools: string[];
  effectiveAllowedTools: string[];
  toolAccess: JobToolAccessView;
  recentRunErrors: Array<{
    runId: string;
    status: string;
    errorSummary: string;
    endedAt: string | null;
  }>;
  staleness: SchedulerJobStaleness | null;
}

export async function buildJobVisibilityMetadata(input: {
  job: Job;
  ops: Pick<RuntimeJobRepository, 'listJobRuns'>;
  toolRepository?: ToolCatalogRepository;
  appId?: string;
  recentRunLimit?: number;
  nowMs?: number;
}): Promise<JobVisibilityMetadata> {
  const appId = input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
  const executionContext = resolveExecutionContext(input.job);
  const notificationRoutes = resolveNotificationRoutes(
    input.job,
    executionContext,
  );
  const agentId = agentIdForJobGroupScope(input.job.group_scope);
  const policy = await resolveJobToolPolicy({
    job: input.job,
    appId,
    agentId,
    toolRepository: input.toolRepository,
  });
  const nowMs = input.nowMs ?? Date.now();
  const staleness = schedulerJobStaleness(input.job, nowMs);
  const runs =
    typeof input.ops.listJobRuns === 'function'
      ? await input.ops.listJobRuns(input.job.id, input.recentRunLimit ?? 5)
      : [];
  return {
    executionContext,
    notificationRoutes,
    target: {
      appId,
      agentId,
      groupScope: input.job.group_scope,
      conversationJids: dedupeConversationJids(notificationRoutes),
      threadId: executionContext.threadId,
    },
    promptPreview: promptPreview(input.job.prompt),
    fullPrompt: input.job.prompt,
    inheritedTools: policy.inheritedTools,
    jobExtraTools: policy.jobExtraTools,
    effectiveAllowedTools: policy.effectiveAllowedTools,
    toolAccess: buildJobToolAccessView({
      inheritedAgentTools: policy.inheritedTools,
      jobExtraTools: policy.jobExtraTools,
      effectiveAllowedTools: policy.effectiveAllowedTools,
    }),
    staleness,
    recentRunErrors: runs
      .filter((run) => Boolean(run.error_summary))
      .map((run) => ({
        runId: run.run_id,
        status: run.status,
        errorSummary: run.error_summary ?? '',
        endedAt: run.ended_at,
      })),
  };
}

export async function buildJobListVisibilityMetadata(input: {
  jobs: Job[];
  toolRepository?: ToolCatalogRepository;
  appId?: string;
  nowMs?: number;
}): Promise<Map<string, JobVisibilityMetadata>> {
  const nowMs = input.nowMs ?? Date.now();
  const inheritedToolsByTarget = new Map<string, Promise<string[]>>();
  const loadInheritedTools = (appId: string, agentId: string) => {
    const key = `${appId}\0${agentId}`;
    let promise = inheritedToolsByTarget.get(key);
    if (!promise) {
      promise = resolveAgentToolBindings({
        repository: input.toolRepository,
        appId,
        agentId,
      });
      inheritedToolsByTarget.set(key, promise);
    }
    return promise;
  };

  return new Map(
    await Promise.all(
      input.jobs.map(async (job) => {
        const appId = input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
        const executionContext = resolveExecutionContext(job);
        const notificationRoutes = resolveNotificationRoutes(
          job,
          executionContext,
        );
        const agentId = agentIdForJobGroupScope(job.group_scope);
        const inheritedTools = await loadInheritedTools(appId, agentId);
        const jobExtraTools = normalizeJobExtraTools(
          job.capability_policy?.allowed_tools,
        );
        const effectiveAllowedTools = mergeUnique(
          inheritedTools,
          jobExtraTools,
        );
        const metadata: JobVisibilityMetadata = {
          executionContext,
          notificationRoutes,
          target: {
            appId,
            agentId,
            groupScope: job.group_scope,
            conversationJids: dedupeConversationJids(notificationRoutes),
            threadId: executionContext.threadId,
          },
          promptPreview: promptPreview(job.prompt),
          inheritedTools,
          jobExtraTools,
          effectiveAllowedTools,
          toolAccess: buildJobToolAccessView({
            inheritedAgentTools: inheritedTools,
            jobExtraTools,
            effectiveAllowedTools,
          }),
          staleness: schedulerJobStaleness(job, nowMs),
          recentRunErrors: [],
        };
        return [job.id, metadata] as const;
      }),
    ),
  );
}

function promptPreview(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function resolveExecutionContext(job: Job): JobExecutionContextInput {
  const stored = job.execution_context;
  if (
    stored &&
    typeof stored.conversationJid === 'string' &&
    stored.conversationJid.trim() &&
    typeof stored.groupScope === 'string' &&
    stored.groupScope.trim()
  ) {
    return {
      conversationJid: stored.conversationJid,
      threadId: stored.threadId ?? null,
      groupScope: stored.groupScope,
      sessionId:
        stored.sessionId === undefined ? job.session_id : stored.sessionId,
    };
  }
  const fallbackConversationJid = Array.isArray(job.notification_routes)
    ? job.notification_routes.find(
        (route) =>
          typeof route?.conversationJid === 'string' &&
          route.conversationJid.trim().length > 0,
      )?.conversationJid
    : undefined;
  return {
    conversationJid: fallbackConversationJid ?? '',
    threadId: job.thread_id,
    groupScope: job.group_scope,
    sessionId: job.session_id,
  };
}

function resolveNotificationRoutes(
  job: Job,
  executionContext: JobExecutionContextInput,
): JobNotificationRouteInput[] {
  const stored = Array.isArray(job.notification_routes)
    ? job.notification_routes
    : [];
  const normalized = stored
    .filter(
      (route): route is JobNotificationRouteInput =>
        typeof route?.conversationJid === 'string' &&
        route.conversationJid.trim().length > 0 &&
        typeof route?.label === 'string' &&
        route.label.trim().length > 0 &&
        (route.threadId === null || typeof route.threadId === 'string'),
    )
    .map((route) => ({
      conversationJid: route.conversationJid.trim(),
      threadId: route.threadId ?? null,
      label: route.label.trim(),
    }));
  if (normalized.length > 0) return normalized;
  return [
    {
      conversationJid: executionContext.conversationJid,
      threadId: executionContext.threadId,
      label: 'primary',
    },
  ];
}

function dedupeConversationJids(routes: readonly JobNotificationRouteInput[]) {
  const out = new Set<string>();
  for (const route of routes) {
    if (route.conversationJid) out.add(route.conversationJid);
  }
  return [...out];
}

function mergeUnique(
  base: readonly string[],
  next: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const item of [...base, ...next]) {
    const value = item.trim();
    if (value) out.add(value);
  }
  return [...out];
}

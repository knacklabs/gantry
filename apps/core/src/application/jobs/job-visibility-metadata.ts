import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import type { Job } from '../../domain/types.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import { resolveJobRuntimeAppId } from './job-access.js';
import {
  agentIdForJobGroupScope,
  normalizeJobExtraTools,
  resolveAgentToolBindings,
  resolveJobToolPolicy,
} from './job-tool-policy.js';

export interface JobVisibilityMetadata {
  target: {
    appId: string;
    agentId: string;
    groupScope: string;
    conversationJids: string[];
    threadId: string | null;
  };
  promptPreview: string;
  fullPrompt?: string;
  notificationTarget: {
    linkedSessions: string[];
    threadId: string | null;
    silent: boolean;
  };
  inheritedTools: string[];
  jobExtraTools: string[];
  effectiveAllowedTools: string[];
  inheritedToolCount?: number;
  jobExtraToolCount?: number;
  effectiveAllowedToolCount?: number;
  recentRunErrors: Array<{
    runId: string;
    status: string;
    errorSummary: string;
    endedAt: string | null;
  }>;
}

export async function buildJobVisibilityMetadata(input: {
  job: Job;
  ops: OpsRepository;
  toolRepository?: ToolCatalogRepository;
  recentRunLimit?: number;
}): Promise<JobVisibilityMetadata> {
  const appId = resolveJobRuntimeAppId(input.job);
  const agentId = agentIdForJobGroupScope(input.job.group_scope);
  const policy = await resolveJobToolPolicy({
    job: input.job,
    appId,
    agentId,
    toolRepository: input.toolRepository,
  });
  const runs =
    typeof input.ops.listJobRuns === 'function'
      ? await input.ops.listJobRuns(input.job.id, input.recentRunLimit ?? 5)
      : [];
  return {
    target: {
      appId,
      agentId,
      groupScope: input.job.group_scope,
      conversationJids: input.job.linked_sessions,
      threadId: input.job.thread_id,
    },
    promptPreview: promptPreview(input.job.prompt),
    fullPrompt: input.job.prompt,
    notificationTarget: {
      linkedSessions: input.job.linked_sessions,
      threadId: input.job.thread_id,
      silent: input.job.silent,
    },
    inheritedTools: policy.inheritedTools,
    jobExtraTools: policy.jobExtraTools,
    effectiveAllowedTools: policy.effectiveAllowedTools,
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
}): Promise<Map<string, JobVisibilityMetadata>> {
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
        const appId = resolveJobRuntimeAppId(job);
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
          target: {
            appId,
            agentId,
            groupScope: job.group_scope,
            conversationJids: job.linked_sessions,
            threadId: job.thread_id,
          },
          promptPreview: promptPreview(job.prompt),
          notificationTarget: {
            linkedSessions: job.linked_sessions,
            threadId: job.thread_id,
            silent: job.silent,
          },
          inheritedTools: [],
          jobExtraTools: [],
          effectiveAllowedTools: [],
          inheritedToolCount: inheritedTools.length,
          jobExtraToolCount: jobExtraTools.length,
          effectiveAllowedToolCount: effectiveAllowedTools.length,
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

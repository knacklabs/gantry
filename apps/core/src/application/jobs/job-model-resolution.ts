import type { Job } from '../../domain/types.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelResolution,
} from '../../shared/model-catalog.js';
import {
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
  type AgentHarness,
} from '../../shared/agent-engine.js';
import { resolveExecutionRoute } from '../../shared/model-execution-route.js';
import type { ExecutionRouteResolution } from '../../shared/model-execution-route.js';

// The engine a job runs on is derived from the resolved job model's provider;
// there is no job-level engine selector. Resolution is
// `modelAlias -> provider -> executionRoute`.
function executionProviderIdForResolution(
  resolution: ModelResolution,
  agentHarness?: AgentHarness,
): ExecutionProviderId | undefined {
  if (!resolution.ok) return undefined;
  const route = resolveExecutionRoute({
    entry: resolution.entry,
    agentHarness,
  });
  return route.ok
    ? (route.value.executionProviderId as ExecutionProviderId)
    : undefined;
}

function routeForResolution(
  resolution?: ModelResolution,
  agentHarness?: AgentHarness,
): ExecutionRouteResolution | undefined {
  return resolution?.ok
    ? resolveExecutionRoute({ entry: resolution.entry, agentHarness })
    : undefined;
}

function engineForResolution(
  resolution?: ModelResolution,
  agentHarness?: AgentHarness,
): AgentEngine {
  if (!resolution?.ok) return DEFAULT_AGENT_ENGINE;
  const route = resolveExecutionRoute({
    entry: resolution.entry,
    agentHarness,
  });
  return route.ok ? route.value.engine : DEFAULT_AGENT_ENGINE;
}

export type JobModelDefaultConfig = {
  model?: string;
  source: string;
};

export interface ResolvedJobModel {
  selectedModel?: string;
  source: string;
  resolution?: ModelResolution;
  entry?: ModelCatalogEntry;
  agentHarness?: AgentHarness;
  routeResolution?: ExecutionRouteResolution;
  agentEngine: AgentEngine;
  defaultExecutionProviderId?: ExecutionProviderId;
}

export function modelUseKindForJobSchedule(
  scheduleType: Job['schedule_type'],
): 'oneTimeJob' | 'recurringJob' {
  return scheduleType === 'cron' || scheduleType === 'interval'
    ? 'recurringJob'
    : 'oneTimeJob';
}

export function jobModelWorkloadForSchedule(
  scheduleType: Job['schedule_type'],
): 'one_time_job' | 'recurring_job' {
  return modelUseKindForJobSchedule(scheduleType) === 'recurringJob'
    ? 'recurring_job'
    : 'one_time_job';
}

export function resolveDefaultJobExecutionProviderId(
  scheduleType: Job['schedule_type'],
  agentHarness?: AgentHarness,
): ExecutionProviderId | undefined {
  const resolution = resolveModelSelectionForWorkload(
    'opus',
    jobModelWorkloadForSchedule(scheduleType),
  );
  return executionProviderIdForResolution(resolution, agentHarness);
}

export function resolveJobModel(
  job: Pick<Job, 'model' | 'schedule_type'>,
  defaultConfig: JobModelDefaultConfig,
  agentHarness?: AgentHarness,
): ResolvedJobModel {
  const selectedModel = job.model || defaultConfig.model;
  const defaultResolution = defaultConfig.model
    ? resolveModelSelectionForWorkload(
        defaultConfig.model,
        jobModelWorkloadForSchedule(job.schedule_type),
      )
    : undefined;
  const resolution = selectedModel
    ? resolveModelSelectionForWorkload(
        selectedModel,
        jobModelWorkloadForSchedule(job.schedule_type),
      )
    : undefined;
  const routeResolution = routeForResolution(resolution, agentHarness);
  return {
    selectedModel,
    source: job.model ? 'job.model' : defaultConfig.source,
    resolution,
    entry: resolution?.ok ? resolution.entry : undefined,
    agentHarness,
    routeResolution,
    agentEngine: routeResolution?.ok
      ? routeResolution.value.engine
      : engineForResolution(resolution, agentHarness),
    defaultExecutionProviderId: defaultResolution
      ? executionProviderIdForResolution(defaultResolution, agentHarness)
      : undefined,
  };
}

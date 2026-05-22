import type { NormalizedModelUsage } from '../shared/model-catalog.js';
import {
  modelUseKindForJobSchedule,
  resolveJobModel,
  type ResolvedJobModel,
} from '../application/jobs/job-model-resolution.js';

export type { NormalizedModelUsage };
export { modelUseKindForJobSchedule, resolveJobModel };

function modelAuditPayload(resolved: ResolvedJobModel) {
  return {
    resolved_model_alias: resolved.resolution?.ok
      ? resolved.resolution.alias
      : null,
    resolved_model_profile_id: resolved.entry?.id ?? null,
    model_source: resolved.source,
    cache_policy: resolved.entry?.cacheMode ?? 'unknown',
  };
}

export function jobStartedModelPayload(resolved: ResolvedJobModel) {
  return {
    ...modelAuditPayload(resolved),
    context_window_tokens: resolved.entry?.contextWindowTokens ?? null,
  };
}

export function jobCompletedModelPayload(
  resolved: ResolvedJobModel,
  usage?: NormalizedModelUsage,
) {
  return {
    usage,
    ...modelAuditPayload(resolved),
  };
}

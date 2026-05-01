import type { Job } from '../domain/types.js';
import {
  resolveModelSelection,
  type ModelCatalogEntry,
  type ModelResolution,
  type NormalizedModelUsage,
} from '../shared/model-catalog.js';

export type { NormalizedModelUsage };

interface DefaultModelConfig {
  model?: string;
  source: string;
}

interface ResolvedJobModel {
  selectedModel?: string;
  source: string;
  resolution?: ModelResolution;
  entry?: ModelCatalogEntry;
}

export function resolveJobModel(
  job: Pick<Job, 'model' | 'schedule_type'>,
  defaultConfig: DefaultModelConfig,
) {
  const selectedModel = job.model || defaultConfig.model;
  const resolution = selectedModel
    ? resolveModelSelection(selectedModel)
    : undefined;
  return {
    selectedModel,
    source: job.model ? 'job.model' : defaultConfig.source,
    resolution,
    entry: resolution?.ok ? resolution.entry : undefined,
  } satisfies ResolvedJobModel;
}

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

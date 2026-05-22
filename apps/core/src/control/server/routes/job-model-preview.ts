import { ApplicationError } from '../../../application/common/application-error.js';
import { resolveRequestedJobModel } from '../../../application/jobs/job-model-selection.js';
import { resolveModelSelectionForWorkload } from '../../../shared/model-catalog.js';
import type { ControlRouteContext } from '../handler-context.js';

export function modelPreviewFor(input: {
  explicitAlias?: string;
  kind: 'manual' | 'once' | 'recurring';
  getDefaultModelConfig: ControlRouteContext['getDefaultModelConfig'];
  agentFolder?: string;
}) {
  const modelKind = input.kind === 'recurring' ? 'recurringJob' : 'oneTimeJob';
  const workload =
    input.kind === 'recurring' ? 'recurring_job' : 'one_time_job';
  const defaultConfig = input.getDefaultModelConfig(
    modelKind,
    input.agentFolder,
  );
  const selected = input.explicitAlias || defaultConfig.model;
  const resolved = selected
    ? resolveModelSelectionForWorkload(selected, workload)
    : undefined;
  if (!resolved?.ok) {
    return {
      modelAlias: input.explicitAlias ?? null,
      modelSource: input.explicitAlias ? 'explicit' : defaultConfig.source,
      model: null,
    };
  }
  return {
    modelAlias: resolved.alias,
    modelSource: input.explicitAlias ? 'explicit' : defaultConfig.source,
    model: {
      displayName: resolved.entry.displayName,
      responseFamily: resolved.entry.responseFamily,
      modelRoute: {
        id: resolved.entry.modelRoute.id,
        label: resolved.entry.modelRoute.label,
      },
      contextWindowTokens: resolved.entry.contextWindowTokens,
      maxOutputTokens: resolved.entry.maxOutputTokens,
      cachePolicy: resolved.entry.cacheMode,
    },
  };
}

export function resolveCreateJobModel(input: {
  modelAlias: unknown;
  kind: 'manual' | 'once' | 'recurring';
  getDefaultModelConfig: ControlRouteContext['getDefaultModelConfig'];
  agentFolder?: string;
}): {
  modelAlias: string;
  source: string;
  explicit: boolean;
} {
  const requested = resolveRequestedJobModel(
    input.modelAlias,
    input.kind === 'recurring' ? 'recurring_job' : 'one_time_job',
  );
  if (requested) {
    return { modelAlias: requested, source: 'explicit', explicit: true };
  }
  const modelKind = input.kind === 'recurring' ? 'recurringJob' : 'oneTimeJob';
  const defaultConfig = input.getDefaultModelConfig(
    modelKind,
    input.agentFolder,
  );
  const resolved = resolveModelSelectionForWorkload(
    defaultConfig.model,
    input.kind === 'recurring' ? 'recurring_job' : 'one_time_job',
  );
  if (!resolved.ok) {
    throw new ApplicationError('INVALID_REQUEST', resolved.message);
  }
  return {
    modelAlias: resolved.alias,
    source: defaultConfig.source,
    explicit: false,
  };
}

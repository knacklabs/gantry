import {
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import { ApplicationError } from '../common/application-error.js';

export type JobModelWorkload = Extract<
  ModelWorkload,
  'one_time_job' | 'recurring_job'
>;

export function resolveOptionalJobModel(
  value: unknown,
  workload: JobModelWorkload = 'one_time_job',
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Job model must be a supported model alias.',
    );
  }
  const resolved = resolveModelSelectionForWorkload(value, workload);
  if (!resolved.ok) {
    throw new ApplicationError('INVALID_REQUEST', resolved.message);
  }
  return resolved.alias;
}

function hasModelValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function resolveRequestedJobModel(
  modelAlias: unknown,
  workload: JobModelWorkload = 'one_time_job',
): string | undefined {
  const hasAlias = hasModelValue(modelAlias);
  if (hasAlias) return resolveOptionalJobModel(modelAlias, workload);
  return undefined;
}

export function resolveRequestedJobModelPatch(
  modelAlias: unknown,
  workload: JobModelWorkload = 'one_time_job',
): { specified: boolean; model?: string | null } {
  const aliasSpecified = modelAlias !== undefined;
  if (!aliasSpecified) return { specified: false };
  const value = modelAlias;
  if (value === null) return { specified: true, model: null };
  if (value === '') {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Use null to clear a job model.',
    );
  }
  return {
    specified: true,
    model: resolveOptionalJobModel(value, workload),
  };
}

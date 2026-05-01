import { resolveModelSelection } from '../../shared/model-catalog.js';
import { ApplicationError } from '../common/application-error.js';

export function resolveOptionalJobModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Job model must be a supported model alias.',
    );
  }
  const resolved = resolveModelSelection(value);
  if (!resolved.ok) {
    throw new ApplicationError('INVALID_REQUEST', resolved.message);
  }
  return resolved.alias;
}

export function resolveRequestedJobModel(
  modelAlias: unknown,
  modelProfileId: unknown,
): string | undefined {
  const hasAlias =
    modelAlias !== undefined && modelAlias !== null && modelAlias !== '';
  const hasProfile =
    modelProfileId !== undefined &&
    modelProfileId !== null &&
    modelProfileId !== '';
  if (hasAlias && hasProfile) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Use either modelAlias or modelProfileId, not both.',
    );
  }
  return resolveOptionalJobModel(hasAlias ? modelAlias : modelProfileId);
}

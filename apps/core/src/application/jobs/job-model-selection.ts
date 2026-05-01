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

function hasModelValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function resolveRequestedJobModel(
  modelAlias: unknown,
  modelProfileId: unknown,
): string | undefined {
  const hasAlias = hasModelValue(modelAlias);
  const hasProfile = hasModelValue(modelProfileId);
  if (hasAlias && hasProfile) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Use either modelAlias or modelProfileId, not both.',
    );
  }
  return resolveOptionalJobModel(hasAlias ? modelAlias : modelProfileId);
}

export type DomainErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'validation_failed'
  | 'permission_denied'
  | 'external_failure';

export interface DomainError {
  code: DomainErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ApplicationErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_SCHEDULE'
  | 'INVALID_REQUEST'
  | 'INVALID_CONTROL_ALLOWLIST'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SCHEDULER_NOT_READY'
  | 'ENQUEUE_FAILED'
  | 'TRIGGER_NOT_FOUND'
  | 'UNAVAILABLE'
  | 'WAIT_TIMEOUT';

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    options?: ErrorOptions & { details?: string[] },
  ) {
    super(message, options);
    this.name = 'ApplicationError';
    this.details = options?.details;
  }

  readonly details?: string[];
}

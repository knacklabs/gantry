export type ApplicationErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_SCHEDULE'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SCHEDULER_NOT_READY'
  | 'TRIGGER_NOT_FOUND'
  | 'UNAVAILABLE'
  | 'WAIT_TIMEOUT';

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApplicationError';
  }
}

export function notImplemented(feature: string): ApplicationError {
  return new ApplicationError(
    'NOT_IMPLEMENTED',
    `${feature} is reserved for the next application-layer migration phase.`,
  );
}

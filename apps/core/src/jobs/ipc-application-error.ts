import { ApplicationError } from '../application/common/application-error.js';

export function mapApplicationError(
  error: unknown,
  fallbackMessage: string,
): {
  message: string;
  code: string;
} {
  if (error instanceof ApplicationError) {
    return {
      message: error.message,
      code: ipcCodeForApplicationError(error.code),
    };
  }
  return {
    message: error instanceof Error ? error.message : fallbackMessage,
    code: 'internal_error',
  };
}

function ipcCodeForApplicationError(code: ApplicationError['code']): string {
  switch (code) {
    case 'NOT_FOUND':
    case 'TRIGGER_NOT_FOUND':
      return 'not_found';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'INVALID_SCHEDULE':
      return 'invalid_schedule';
    case 'INVALID_REQUEST':
      return 'invalid_request';
    case 'SCHEDULER_NOT_READY':
    case 'UNAVAILABLE':
      return 'unavailable';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'WAIT_TIMEOUT':
      return 'timeout';
    case 'CONFLICT':
      return 'conflict';
    case 'NOT_IMPLEMENTED':
    default:
      return 'internal_error';
  }
}

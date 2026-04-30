import { describe, expect, it } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import { mapApplicationError } from '@core/jobs/ipc-application-error.js';

describe('mapApplicationError', () => {
  it.each([
    ['INVALID_SCHEDULE', 'invalid_schedule'],
    ['NOT_FOUND', 'not_found'],
    ['TRIGGER_NOT_FOUND', 'not_found'],
    ['FORBIDDEN', 'forbidden'],
    ['INVALID_REQUEST', 'invalid_request'],
    ['SCHEDULER_NOT_READY', 'unavailable'],
    ['UNAVAILABLE', 'unavailable'],
    ['RATE_LIMITED', 'rate_limited'],
    ['WAIT_TIMEOUT', 'timeout'],
  ] as const)('maps %s to %s', (applicationCode, ipcCode) => {
    expect(
      mapApplicationError(new ApplicationError(applicationCode, 'message'), ''),
    ).toEqual({ message: 'message', code: ipcCode });
  });
});

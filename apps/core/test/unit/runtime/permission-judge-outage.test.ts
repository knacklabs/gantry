import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import {
  judgeOutageLatch,
  observeJudgeAvailability,
} from '@core/runtime/permission-judge-outage.js';

afterEach(() => {
  judgeOutageLatch.clearAll();
  vi.restoreAllMocks();
});

const request = {
  appId: 'app-one',
  providerAccountId: 'account-one',
  targetJid: 'tg:one',
  sourceAgentFolder: 'main_agent',
  toolName: 'Bash',
};
const unavailable = {
  status: PermissionClassifierStatus.Unavailable,
  risk_level: 'high' as const,
  decision: 'ask' as const,
  failureCode: 'wiring_missing' as const,
  reason: 'Classifier unavailable (wiring_missing); ask the user.',
  latencyMs: 0,
};

describe('permission judge outage', () => {
  it('turns an outage into one log line per conversation and the offline reason, and passes an answer through', () => {
    const warn = vi.spyOn(logger, 'warn');

    expect(observeJudgeAvailability(unavailable, request)).toBe(
      'Asking because my safety judge is offline.',
    );
    expect(observeJudgeAvailability(unavailable, request)).toBe(
      'Asking because my safety judge is offline.',
    );
    observeJudgeAvailability(unavailable, { ...request, targetJid: 'tg:two' });
    expect(
      warn.mock.calls.filter(
        ([, message]) =>
          message === 'Permission safety judge is offline; asking a person',
      ),
    ).toHaveLength(2);

    expect(
      observeJudgeAvailability(
        {
          ...unavailable,
          status: PermissionClassifierStatus.Answered,
          reason: 'Needs a person.',
        },
        request,
      ),
    ).toBe('Needs a person.');
  });
});

import { describe, expect, it } from 'vitest';

import {
  createJudgeOutageLatch,
  JUDGE_OFFLINE_REASON,
} from '@core/application/permissions/permission-judge-outage-latch.js';
import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';

describe('permission judge outage latch', () => {
  it('opens on the first unavailable result per app account and conversation key returns logDue once per episode clears on answered ignores skipped and keeps keys independent', () => {
    const latch = createJudgeOutageLatch();
    const first = {
      appId: 'app-one',
      providerAccountId: 'account-one',
      targetJid: 'tg:one',
    };
    const second = { ...first, targetJid: 'tg:two' };

    expect(
      latch.observe(PermissionClassifierStatus.Unavailable, first),
    ).toEqual({
      logDue: true,
    });
    expect(
      latch.observe(PermissionClassifierStatus.Unavailable, first),
    ).toEqual({
      logDue: false,
    });
    expect(latch.observe(PermissionClassifierStatus.Skipped, first)).toEqual({
      logDue: false,
    });
    expect(
      latch.observe(PermissionClassifierStatus.Unavailable, second),
    ).toEqual({
      logDue: true,
    });
    latch.observe(PermissionClassifierStatus.Answered, first);
    expect(
      latch.observe(PermissionClassifierStatus.Unavailable, first),
    ).toEqual({
      logDue: true,
    });
  });

  it('exports the offline reason copy verbatim', () => {
    expect(JUDGE_OFFLINE_REASON).toBe(
      'Asking because my safety judge is offline.',
    );
  });
});

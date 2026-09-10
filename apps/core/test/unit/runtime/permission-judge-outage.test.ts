import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import {
  judgeOutageLatch,
  sendJudgeOfflineNoticeForRequest,
  unavailablePromptConsultResult,
} from '@core/runtime/permission-judge-outage.js';

afterEach(() => judgeOutageLatch.clearAll());

describe('permission judge outage runtime glue', () => {
  it('builds the synthetic unavailable prompt result sends the offline notice once per key with the provider account skips the send without a target and swallows send failures', async () => {
    expect(
      unavailablePromptConsultResult('wiring_missing', Date.now()),
    ).toMatchObject({
      status: PermissionClassifierStatus.Unavailable,
      risk_level: 'high',
      decision: 'ask',
      failureCode: 'wiring_missing',
      reason: 'Classifier unavailable (wiring_missing); ask the user.',
    });

    const sendMessage = vi.fn(async () => undefined);
    const request = {
      appId: 'app-one',
      providerAccountId: 'account-one',
      targetJid: 'tg:one',
      threadId: 'thread-one',
    };
    const unavailable = unavailablePromptConsultResult(
      'wiring_missing',
      Date.now(),
    );
    await sendJudgeOfflineNoticeForRequest(unavailable, sendMessage, request);
    await sendJudgeOfflineNoticeForRequest(unavailable, sendMessage, request);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:one',
      "My safety judge is offline, so I'll check with you more than usual until it's back.",
      { threadId: 'thread-one', providerAccountId: 'account-one' },
    );

    await sendJudgeOfflineNoticeForRequest(unavailable, sendMessage, {
      ...request,
      targetJid: undefined,
    });
    expect(sendMessage).toHaveBeenCalledOnce();

    await expect(
      sendJudgeOfflineNoticeForRequest(unavailable, undefined, {
        ...request,
        targetJid: 'tg:missing-sender',
      }),
    ).resolves.toBeUndefined();

    judgeOutageLatch.clearAll();
    await expect(
      sendJudgeOfflineNoticeForRequest(
        unavailable,
        vi.fn(async () => {
          throw new Error('offline delivery');
        }),
        request,
      ),
    ).resolves.toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import {
  judgeOutageLatch,
  sendJudgeOfflineNotice,
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
    const input = {
      sendMessage,
      appId: 'app-one',
      providerAccountId: 'account-one',
      targetJid: 'tg:one',
      threadId: 'thread-one',
    };
    await sendJudgeOfflineNotice(input);
    await sendJudgeOfflineNotice(input);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:one',
      "My safety judge is offline, so I'll check with you more than usual until it's back.",
      { threadId: 'thread-one', providerAccountId: 'account-one' },
    );

    await sendJudgeOfflineNotice({ ...input, targetJid: undefined });
    expect(sendMessage).toHaveBeenCalledOnce();

    judgeOutageLatch.clearAll();
    await expect(
      sendJudgeOfflineNotice({
        ...input,
        sendMessage: vi.fn(async () => {
          throw new Error('offline delivery');
        }),
      }),
    ).resolves.toBeUndefined();
  });
});

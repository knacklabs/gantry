import { describe, expect, it, vi } from 'vitest';

import { createChannelMessageActionRouter } from '@core/app/bootstrap/channel-message-action-router.js';
import { registerLiveStopMessageAction } from '@core/app/bootstrap/runtime-live-stop-message-action.js';

describe('createChannelMessageActionRouter', () => {
  it('routes live stop callbacks to the registered handler', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    router.set(handler);
    const actionToken = '67ad9359-9a43-4fb7-a782-c21a5ef9442a';
    expect(`lt:stop:${actionToken}`.length).toBeLessThanOrEqual(64);

    await router.handle({
      kind: 'live_turn_stop',
      conversationJid: 'tg:chat',
      threadId: 'topic',
      actionToken,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed live stop callback tokens', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    router.set(handler);

    await router.handle({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      actionToken: 'token-1',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('routes scheduler run-now callbacks to the registered handler', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    router.set(handler);

    await router.handle({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      userId: 'U123',
      jobId: 'job-1',
      runId: 'run-1',
    });

    expect(handler).toHaveBeenCalledWith({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      userId: 'U123',
      jobId: 'job-1',
      runId: 'run-1',
    });
  });

  it('rejects scheduler run-now callbacks without a job id', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    router.set(handler);

    await router.handle({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      jobId: '   ',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores callbacks when no handler is registered', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    await router.handle({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      actionToken: 'token-1',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('runs scheduler run-now callbacks after same-channel approval', async () => {
    const sendMessage = vi.fn(async () => {});
    const runSchedulerNow = vi.fn(async () => 'Scheduler job queued (job-1).');
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage,
    };
    registerLiveStopMessageAction({
      channelWiring: channelWiring as any,
      sourceAgentFolderFor: () => 'main_agent',
      conversationBindings: () => ({
        'sl:C123': { folder: 'main_agent' },
      }),
      stopGroup: vi.fn(),
      runSchedulerNow,
    });

    await handler?.({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      threadId: 'thread-1',
      userId: 'U123',
      jobId: 'job-1',
    });

    expect(runSchedulerNow).toHaveBeenCalledWith({
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      originConversationJid: 'sl:C123',
      authThreadId: 'thread-1',
      conversationBindings: { 'sl:C123': { folder: 'main_agent' } },
      sourceConversationJids: ['sl:C123'],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Scheduler job queued (job-1).',
      {
        durability: 'required',
        messageOptions: { threadId: 'thread-1' },
      },
    );
  });
});

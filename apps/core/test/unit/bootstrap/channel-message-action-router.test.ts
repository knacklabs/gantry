import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const processTaskIpcMock = vi.hoisted(() => vi.fn());

vi.mock('@core/runtime/ipc.js', () => ({
  processTaskIpc: processTaskIpcMock,
}));

import { DATA_DIR } from '@core/config/index.js';
import { createChannelMessageActionRouter } from '@core/app/bootstrap/channel-message-action-router.js';
import {
  registerLiveStopMessageAction,
  registerRuntimeLiveStopMessageAction,
} from '@core/app/bootstrap/runtime-live-stop-message-action.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

describe('createChannelMessageActionRouter', () => {
  afterEach(() => {
    processTaskIpcMock.mockReset();
    fs.rmSync(path.join(DATA_DIR, 'ipc', 'main_agent', 'task-responses'), {
      recursive: true,
      force: true,
    });
  });

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

  it('does not pick an arbitrary agent route when scheduler action source is ambiguous', async () => {
    const sendMessage = vi.fn(async () => {});
    const runSchedulerNow = vi.fn(async () => 'Scheduler job queued (job-1).');
    const alphaRouteKey = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const triageRouteKey = makeAgentThreadQueueKey('sl:C123', 'agent:triage');
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage,
    };
    registerRuntimeLiveStopMessageAction(
      channelWiring as any,
      {
        getConversationRoutes: () => ({
          'sl:C123': { folder: 'legacy' },
          [alphaRouteKey]: { folder: 'alpha' },
          [triageRouteKey]: { folder: 'triage' },
        }),
      },
      { stopGroup: vi.fn() },
      { runNow: runSchedulerNow },
    );

    await handler?.({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      userId: 'U123',
      jobId: 'job-1',
    });

    expect(runSchedulerNow).not.toHaveBeenCalled();
    expect(channelWiring.isControlApproverAllowed).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses the thread-qualified route when a scheduler action includes that route identity', async () => {
    const sendMessage = vi.fn(async () => {});
    const runSchedulerNow = vi.fn(async () => 'Scheduler job queued (job-1).');
    const alphaRouteKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      'thread-1',
    );
    const triageRouteKey = makeAgentThreadQueueKey('sl:C123', 'agent:triage');
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage,
    };
    registerRuntimeLiveStopMessageAction(
      channelWiring as any,
      {
        getConversationRoutes: () => ({
          [alphaRouteKey]: { folder: 'alpha' },
          [triageRouteKey]: { folder: 'triage' },
        }),
      },
      { stopGroup: vi.fn() },
      { runNow: runSchedulerNow },
    );

    await handler?.({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      threadId: 'thread-1',
      userId: 'U123',
      jobId: 'job-1',
    });

    expect(runSchedulerNow).toHaveBeenCalledWith({
      jobId: 'job-1',
      sourceAgentFolder: 'alpha',
      originConversationJid: 'sl:C123',
      authThreadId: 'thread-1',
      conversationBindings: {
        [alphaRouteKey]: { folder: 'alpha' },
        [triageRouteKey]: { folder: 'triage' },
      },
      sourceConversationJids: ['sl:C123'],
    });
    expect(channelWiring.isControlApproverAllowed).toHaveBeenCalledWith({
      conversationJid: 'sl:C123',
      userId: 'U123',
      sourceAgentFolder: 'alpha',
      decisionPolicy: 'same_channel',
    });
  });

  it('does not stop live runs when the action source route is ambiguous', async () => {
    const actionToken = '67ad9359-9a43-4fb7-a782-c21a5ef9442a';
    const stopGroup = vi.fn(async () => false);
    const sendMessage = vi.fn(async () => {});
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage,
    };
    registerRuntimeLiveStopMessageAction(
      channelWiring as any,
      {
        getConversationRoutes: () => ({
          [makeAgentThreadQueueKey('sl:C123', 'agent:beta')]: {
            folder: 'beta',
          },
          [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: {
            folder: 'alpha',
          },
        }),
      },
      { stopGroup },
    );

    await handler?.({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      userId: 'U123',
      actionToken,
    });

    expect(stopGroup).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not fall back to the active thread queue when a live stop action token misses', async () => {
    const actionToken = '67ad9359-9a43-4fb7-a782-c21a5ef9442a';
    const sendMessage = vi.fn(async () => {});
    const stopGroup = vi.fn(async () => false);
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
      stopGroup,
    });

    await handler?.({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      threadId: 'thread-1',
      userId: 'U123',
      actionToken,
    });

    expect(stopGroup).toHaveBeenNthCalledWith(1, actionToken);
    expect(stopGroup).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports scheduler run-now IPC rejection instead of a blind success', async () => {
    processTaskIpcMock.mockImplementation(
      async (
        data: {
          taskId?: string;
          authThreadId?: string;
          responseKeyId?: string;
        },
        sourceAgentFolder: string,
      ) => {
        writeTaskIpcResponse(
          sourceAgentFolder,
          data.taskId,
          {
            ok: false,
            code: 'conflict',
            error:
              'scheduler_run_now requires an active job; current status is paused.',
          },
          data.authThreadId,
          data.responseKeyId,
        );
      },
    );
    const sendMessage = vi.fn(async () => undefined);
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage,
    };

    registerRuntimeLiveStopMessageAction(
      channelWiring as any,
      {
        getConversationRoutes: () => ({
          'sl:C123': { folder: 'main_agent' },
        }),
      },
      { stopGroup: vi.fn() },
    );

    await handler?.({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C123',
      userId: 'U123',
      jobId: 'job-1',
    });

    expect(processTaskIpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler_run_now',
        jobId: 'job-1',
        taskId: expect.any(String),
        responseKeyId: expect.any(String),
      }),
      'main_agent',
      expect.any(Object),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'scheduler_run_now requires an active job; current status is paused.',
      { durability: 'required' },
    );
  });
});

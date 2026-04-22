import { describe, expect, it, vi } from 'vitest';

import { startRuntimeServices } from '@core/bootstrap/runtime-services.js';
import { RuntimeApp } from '@core/bootstrap/runtime-app.js';
import { ChannelWiring } from '@core/bootstrap/channel-wiring.js';

function makeApp(): RuntimeApp {
  const queue = {
    registerProcess: vi.fn(),
    setProcessMessagesFn: vi.fn(),
    closeStdin: vi.fn(),
    notifyIdle: vi.fn(),
    isGroupActive: vi.fn(),
    stopGroup: vi.fn(),
    sendMessage: vi.fn(),
    enqueueMessageCheck: vi.fn(),
  };

  return {
    channels: [],
    queue: queue as any,
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(() => ''),
    registerGroup: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setRegisteredGroupsForTest: vi.fn(),
    ensureOneCLIAgentsForRegisteredGroups: vi.fn(),
    clearSessionForChatJid: vi.fn(),
    processGroupMessages: vi.fn(async () => true),
    getRegisteredGroups: vi.fn(() => ({
      'tg:main': {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
        isMain: true,
      },
    })),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
  };
}

function makeChannelWiring(): ChannelWiring {
  return {
    connectEnabledChannels: vi.fn(),
    findChannel: vi.fn(() => undefined),
    sendMessage: vi.fn(async () => {}),
    sendStreamingChunk: vi.fn(async () => {}),
    resetStreaming: vi.fn(),
    syncGroups: vi.fn(async () => {}),
    requestPermissionApproval: vi.fn(async () => ({ approved: true })),
    requestUserAnswer: vi.fn(async () => ({ requestId: 'q', answers: {} })),
  };
}

describe('startRuntimeServices', () => {
  it('preserves runtime-services startup order and snapshot shape', () => {
    const order: string[] = [];
    const app = makeApp();
    const channelWiring = makeChannelWiring();

    const jobs = [
      {
        id: 'job-1',
        name: 'Job 1',
        prompt: 'Do thing',
        model: '',
        script: '',
        schedule_type: 'interval',
        schedule_value: '',
        status: 'active',
        group_scope: 'tg:main',
        linked_sessions: [],
        thread_id: null,
        next_run: null,
        created_by: 'human',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        silent: false,
        cleanup_after_ms: 0,
        timeout_ms: 1000,
        max_retries: 0,
        retry_backoff_ms: 0,
        max_consecutive_failures: 0,
        consecutive_failures: 0,
        execution_mode: 'parallel',
        pause_reason: null,
      },
    ] as any;

    const writeJobsSnapshot = vi.fn((_folder, _isMain, rows) => {
      order.push('writeJobsSnapshot');
      expect(rows[0].model).toBeNull();
      expect(rows[0].script).toBeUndefined();
      expect(rows[0].pause_reason).toBeNull();
    });

    startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn(() => {
          order.push('startSchedulerLoop');
        }) as any,
        startIpcWatcher: vi.fn(() => {
          order.push('startIpcWatcher');
        }) as any,
        writeSchedulerStateFileSafe: vi.fn(() => {
          order.push('writeSchedulerStateFileSafe');
        }) as any,
        writeJobsSnapshot: writeJobsSnapshot as any,
        writeJobRunsSnapshot: vi.fn(() => {
          order.push('writeJobRunsSnapshot');
        }) as any,
        writeJobEventsSnapshot: vi.fn(() => {
          order.push('writeJobEventsSnapshot');
        }) as any,
        writeGroupsSnapshot: vi.fn() as any,
        getAllJobs: vi.fn(() => jobs) as any,
        getRecentJobRuns: vi.fn(() => []) as any,
        listRecentJobEvents: vi.fn(() => []) as any,
        recoverPendingMessages: vi.fn(() => {
          order.push('recoverPendingMessages');
        }) as any,
        startMessagePollingLoop: vi.fn(() => {
          order.push('startMessagePollingLoop');
          return new Promise<never>(() => {});
        }) as any,
        logger: {
          info: vi.fn(() => {
            order.push('runtime-ready-log');
          }),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    expect(order).toEqual([
      'startSchedulerLoop',
      'startIpcWatcher',
      'writeSchedulerStateFileSafe',
      'writeJobsSnapshot',
      'writeJobRunsSnapshot',
      'writeJobEventsSnapshot',
      'recoverPendingMessages',
      'runtime-ready-log',
      'startMessagePollingLoop',
    ]);

    expect((app.queue.setProcessMessagesFn as any).mock.calls).toHaveLength(1);
  });

  it('targets active control commands at the originating thread queue', async () => {
    let capturedDeps:
      | import('@core/runtime/message-loop.js').MessageLoopDeps
      | undefined;
    const app = makeApp();
    const channelWiring = makeChannelWiring();

    vi.mocked(app.queue.isGroupActive as any).mockReturnValue(true);
    vi.mocked(app.queue.stopGroup as any).mockReturnValue(true);

    startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeSchedulerStateFileSafe: vi.fn() as any,
        writeJobsSnapshot: vi.fn() as any,
        writeJobRunsSnapshot: vi.fn() as any,
        writeJobEventsSnapshot: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        getAllJobs: vi.fn(() => []) as any,
        getRecentJobRuns: vi.fn(() => []) as any,
        listRecentJobEvents: vi.fn(() => []) as any,
        recoverPendingMessages: vi.fn() as any,
        startMessagePollingLoop: vi.fn((deps) => {
          capturedDeps = deps;
          return new Promise<never>(() => {});
        }) as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    const handled = await capturedDeps?.handleActiveControlCommand?.({
      chatJid: 'tg:main',
      queueJid: 'tg:main::thread:topic-42',
      group: {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
        isMain: true,
      },
      command: { kind: 'stop', raw: '/stop' } as any,
      message: {
        id: '1',
        chat_jid: 'tg:main',
        sender: 'user',
        sender_name: 'User',
        content: '/stop',
        timestamp: '2026-01-01T00:00:00.000Z',
        thread_id: 'topic-42',
      },
    });

    expect(handled).toBe(true);
    expect(app.queue.isGroupActive).toHaveBeenCalledWith(
      'tg:main::thread:topic-42',
    );
    expect(app.queue.stopGroup).toHaveBeenCalledWith(
      'tg:main::thread:topic-42',
    );
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:main',
      'Stopping current run.',
      { messageOptions: { threadId: 'topic-42' } },
    );
  });

  it('clears only the originating thread session for active /new commands', async () => {
    let capturedDeps:
      | import('@core/runtime/message-loop.js').MessageLoopDeps
      | undefined;
    const app = makeApp();
    const channelWiring = makeChannelWiring();

    vi.mocked(app.queue.isGroupActive as any).mockReturnValue(true);
    vi.mocked(app.queue.stopGroup as any).mockReturnValue(true);

    startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeSchedulerStateFileSafe: vi.fn() as any,
        writeJobsSnapshot: vi.fn() as any,
        writeJobRunsSnapshot: vi.fn() as any,
        writeJobEventsSnapshot: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        getAllJobs: vi.fn(() => []) as any,
        getRecentJobRuns: vi.fn(() => []) as any,
        listRecentJobEvents: vi.fn(() => []) as any,
        recoverPendingMessages: vi.fn() as any,
        startMessagePollingLoop: vi.fn((deps) => {
          capturedDeps = deps;
          return new Promise<never>(() => {});
        }) as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    const handled = await capturedDeps?.handleActiveControlCommand?.({
      chatJid: 'tg:main',
      queueJid: 'tg:main::thread:topic-42',
      group: {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
        isMain: true,
      },
      command: { kind: 'new', raw: '/new' } as any,
      message: {
        id: '1',
        chat_jid: 'tg:main',
        sender: 'user',
        sender_name: 'User',
        content: '/new',
        timestamp: '2026-01-01T00:00:00.000Z',
        thread_id: 'topic-42',
      },
    });

    expect(handled).toBe(true);
    expect(app.clearSessionForChatJid).toHaveBeenCalledWith(
      'tg:main',
      'topic-42',
    );
    expect(app.setAgentCursor).toHaveBeenCalledWith(
      'tg:main::thread:topic-42',
      expect.any(String),
    );
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:main',
      'Started a fresh session.',
      { messageOptions: { threadId: 'topic-42' } },
    );
  });
});

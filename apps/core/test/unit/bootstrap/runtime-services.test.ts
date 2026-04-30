import { describe, expect, it, vi } from 'vitest';

import { startRuntimeServices } from '@core/app/bootstrap/runtime-services.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { ChannelWiring } from '@core/app/bootstrap/channel-wiring.js';

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
    ensureCredentialBindingsForRegisteredGroups: vi.fn(),
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
  it('preserves runtime-services startup order and snapshot shape', async () => {
    const order: string[] = [];
    const app = makeApp();
    const channelWiring = makeChannelWiring();

    await startRuntimeServices(
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
        writeGroupsSnapshot: vi.fn(() => {
          order.push('writeGroupsSnapshot');
        }) as any,
        opsRepository: {} as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual([
      'startSchedulerLoop',
      'startIpcWatcher',
      'recoverPendingMessages',
      'runtime-ready-log',
      'startMessagePollingLoop',
      'writeGroupsSnapshot',
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

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
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

  it('does not refresh job snapshots on scheduler changes', async () => {
    let schedulerDeps:
      | import('@core/jobs/scheduler.js').SchedulerDependencies
      | undefined;
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const writeGroupsSnapshot = vi.fn();

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn((deps) => {
          schedulerDeps = deps;
        }) as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot,
        opsRepository: {} as any,
        recoverPendingMessages: vi.fn() as any,
        startMessagePollingLoop: vi.fn(
          () => new Promise<never>(() => {}),
        ) as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    schedulerDeps?.onSchedulerChanged?.();
    schedulerDeps?.onSchedulerChanged?.();
    schedulerDeps?.onSchedulerChanged?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(writeGroupsSnapshot).toHaveBeenCalledTimes(1);
  });

  it('clears only the originating thread session for active /new commands', async () => {
    let capturedDeps:
      | import('@core/runtime/message-loop.js').MessageLoopDeps
      | undefined;
    const app = makeApp();
    const channelWiring = makeChannelWiring();

    vi.mocked(app.queue.isGroupActive as any).mockReturnValue(true);
    vi.mocked(app.queue.stopGroup as any).mockReturnValue(true);

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
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

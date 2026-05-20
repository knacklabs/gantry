import { describe, expect, it, vi } from 'vitest';

import { startRuntimeServices } from '@core/app/bootstrap/runtime-services.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { ChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import { runBoundedOutboundDeliveryRecovery } from '@core/jobs/outbound-delivery-recovery.js';

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
    executionAdapter: {
      id: 'anthropic:claude-agent-sdk',
      prepare: vi.fn(),
    },
    channels: [],
    queue: queue as any,
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(() => ''),
    registerGroup: vi.fn(),
    projectConversationRoute: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setConversationRoutesForTest: vi.fn(),
    ensureCredentialBindingsForConversationRoutes: vi.fn(),
    clearSessionForChatJid: vi.fn(),
    processGroupMessages: vi.fn(async () => true),
    getConversationRoutes: vi.fn(() => ({
      'tg:primary': {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
      },
    })),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
  };
}

function makeChannelWiring(): ChannelWiring {
  const createRecoveryDispatchPermit = vi.fn((input: any) => ({
    ...input,
    __permit: 'recovery',
  }));
  return {
    describeDestinationJid: vi.fn((jid: string) => {
      if (jid.startsWith('sl:'))
        return {
          providerId: 'slack',
          internal: false,
          runtimeAppId: 'default' as never,
        };
      if (jid.startsWith('tg:'))
        return {
          providerId: 'telegram',
          internal: false,
          runtimeAppId: 'default' as never,
        };
      if (jid.startsWith('teams:'))
        return {
          providerId: 'teams',
          internal: false,
          runtimeAppId: 'default' as never,
        };
      if (jid.startsWith('app:'))
        return {
          providerId: 'app',
          internal: true,
          runtimeAppId: 'default' as never,
        };
      return { internal: false, runtimeAppId: 'default' as never };
    }),
    connectEnabledChannels: vi.fn(),
    hasConnectedChannels: vi.fn(() => true),
    hasChannel: vi.fn((jid: string) => jid !== 'tg:missing'),
    supportsStreaming: vi.fn(() => false),
    supportsProgress: vi.fn(() => false),
    sendMessage: vi.fn(async () => {}),
    sendProviderMessage: vi.fn(async () => ({})),
    createRecoveryDispatchPermit,
    setRetryTailRecoveryEnqueue: vi.fn(),
    setDurableOutboundAttemptFactory: vi.fn(),
    sendStreamingChunk: vi.fn(async () => {}),
    resetStreaming: vi.fn(),
    setTyping: vi.fn(async () => {}),
    sendProgressUpdate: vi.fn(async () => {}),
    syncGroups: vi.fn(async () => {}),
    requestPermissionApproval: vi.fn(async () => ({ approved: true })),
    requestUserAnswer: vi.fn(async () => ({ requestId: 'q', answers: {} })),
    disconnectChannels: vi.fn(async () => {}),
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
        getToolRepository: vi.fn(() => ({}) as any),
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
      'startIpcWatcher',
      'recoverPendingMessages',
      'startSchedulerLoop',
      'writeGroupsSnapshot',
      'runtime-ready-log',
      'startMessagePollingLoop',
    ]);

    expect((app.queue.setProcessMessagesFn as any).mock.calls).toHaveLength(1);
  });

  it('installs durable outbound delivery before scheduler startup', async () => {
    const order: string[] = [];
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    vi.mocked(
      channelWiring.setDurableOutboundAttemptFactory as any,
    ).mockImplementation(() => {
      order.push('setDurableOutboundAttemptFactory');
    });

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
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
        startMessagePollingLoop: vi.fn(
          () => new Promise<never>(() => {}),
        ) as any,
        startOutboundDeliveryRecoveryLoop: vi.fn(() => {
          order.push('startOutboundDeliveryRecoveryLoop');
        }) as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    expect(order).toEqual([
      'startIpcWatcher',
      'setDurableOutboundAttemptFactory',
      'startOutboundDeliveryRecoveryLoop',
      'startSchedulerLoop',
    ]);
  });

  it('wires durable scheduler sends', async () => {
    let schedulerDeps:
      | import('@core/jobs/scheduler.js').SchedulerDependencies
      | undefined;
    const app = makeApp();
    const channelWiring = makeChannelWiring();

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
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
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

    expect(schedulerDeps).toBeDefined();
    await schedulerDeps?.sendMessage('tg:primary', 'scheduler output', {
      threadId: 'thread-42',
    });
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:primary',
      'scheduler output',
      {
        durability: 'required',
        messageOptions: { threadId: 'thread-42' },
      },
    );
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
        getToolRepository: vi.fn(() => ({}) as any),
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
      chatJid: 'tg:primary',
      queueJid: 'tg:primary::thread:topic-42',
      group: {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
      },
      command: { kind: 'stop', raw: '/stop' } as any,
      message: {
        id: '1',
        chat_jid: 'tg:primary',
        sender: 'user',
        sender_name: 'User',
        content: '/stop',
        timestamp: '2026-01-01T00:00:00.000Z',
        thread_id: 'topic-42',
      },
    });

    expect(handled).toBe(true);
    expect(app.queue.isGroupActive).toHaveBeenCalledWith(
      'tg:primary::thread:topic-42',
    );
    expect(app.queue.stopGroup).toHaveBeenCalledWith(
      'tg:primary::thread:topic-42',
    );
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:primary',
      'Stopping current run.',
      { durability: 'required', messageOptions: { threadId: 'topic-42' } },
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
        getToolRepository: vi.fn(() => ({}) as any),
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
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'app:default',
      agentId: 'agent:main',
      agentSessionId: 'agent-session:main',
    }));
    const collectSessionMemory = vi.fn(async () => ({ saved: 0 }));

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
        opsRepository: { getAgentTurnContext } as any,
        collectSessionMemory: collectSessionMemory as any,
        getToolRepository: vi.fn(() => ({}) as any),
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
      chatJid: 'tg:primary',
      queueJid: 'tg:primary::thread:topic-42',
      group: {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
      },
      command: { kind: 'new', raw: '/new' } as any,
      message: {
        id: '1',
        chat_jid: 'tg:primary',
        sender: 'user',
        sender_name: 'User',
        content: '/new',
        timestamp: '2026-01-01T00:00:00.000Z',
        thread_id: 'topic-42',
      },
    });

    expect(handled).toBe(true);
    expect(app.clearSessionForChatJid).toHaveBeenCalledWith(
      'tg:primary',
      'topic-42',
      { memoryUserId: 'user' },
    );
    expect(getAgentTurnContext).toHaveBeenCalledWith({
      agentFolder: 'main',
      executionProviderId: 'anthropic:claude-agent-sdk',
      conversationJid: 'tg:primary',
      threadId: 'topic-42',
      conversationKind: undefined,
      memoryUserId: 'user',
      hydrateMemory: false,
    });
    expect(collectSessionMemory).toHaveBeenCalledWith({
      agentSessionId: 'agent-session:main',
      trigger: 'session-end',
      defaultScope: 'group',
    });
    expect(app.setAgentCursor).toHaveBeenCalledWith(
      'tg:primary::thread:topic-42',
      expect.any(String),
    );
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:primary',
      'Started a fresh session.',
      { durability: 'required', messageOptions: { threadId: 'topic-42' } },
    );
  });

  it('starts outbound delivery recovery loop when repository seam is provided', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:1',
          appId: 'default',
          conversationId: 'control:app-one:conversation:conv-1',
          threadId: 'thread-1',
        },
        item: {
          id: 'delivery-item:1',
          canonicalText: 'Recovered outbound',
          providerPayload: { jid: 'tg:primary', threadId: 'thread-1' },
        },
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'tg:primary',
                threadId: 'thread-1',
                providerId: 'telegram',
                providerConnectionId: 'telegram_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(startOutboundDeliveryRecoveryLoop).toHaveBeenCalledTimes(1);
    expect(startOutboundDeliveryRecoveryLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        claimerId: expect.stringContaining('runtime-recovery:'),
        batchLimit: 25,
        maxBatches: 5,
        intervalMs: 5_000,
      }),
    );
    expect(
      startOutboundDeliveryRecoveryLoop.mock.calls[0]?.[0],
    ).not.toHaveProperty('appId');
    expect(channelWiring.sendMessage).not.toHaveBeenCalled();
    expect(channelWiring.createRecoveryDispatchPermit).toHaveBeenCalledWith({
      deliveryId: 'delivery:1',
      itemId: 'delivery-item:1',
      destinationJid: 'tg:primary',
      canonicalText: 'Recovered outbound',
      threadId: 'thread-1',
    });
    expect(channelWiring.sendProviderMessage).toHaveBeenCalledWith(
      'tg:primary',
      'Recovered outbound',
      expect.objectContaining({
        throwOnMissing: true,
        messageOptions: { threadId: 'thread-1' },
        permit: expect.objectContaining({
          deliveryId: 'delivery:1',
          itemId: 'delivery-item:1',
          destinationJid: 'tg:primary',
          canonicalText: 'Recovered outbound',
          threadId: 'thread-1',
        }),
      }),
    );
  });

  it('accepts raw provider destination hints when canonical destination is provider-prefixed', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:slack:1',
          appId: 'default',
          conversationId: 'conversation:provider-connection:slack:C123',
          threadId: 'thread-1',
        },
        item: {
          id: 'delivery-item:slack:1',
          canonicalText: 'Recovered outbound',
          providerPayload: { jid: 'C123', threadId: 'thread-1' },
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'sl:C123',
                threadId: 'thread-1',
                providerId: 'slack',
                providerConnectionId: 'slack_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(expect.objectContaining({ status: 'sent' }));
    expect(channelWiring.sendProviderMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Recovered outbound',
      expect.objectContaining({
        throwOnMissing: true,
        messageOptions: { threadId: 'thread-1' },
        permit: expect.objectContaining({
          destinationJid: 'sl:C123',
          canonicalText: 'Recovered outbound',
        }),
      }),
    );
  });

  it('normalizes teams raw conversationId retry-tail hints to canonical teams jid', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const rawTeamsConversationId = '19:abc123def456ghi789@thread.tacv2';
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:teams:1',
          appId: 'default',
          conversationId: 'conversation:provider-connection:teams:main',
          threadId: 'thread-1',
        },
        item: {
          id: 'delivery-item:teams:1',
          canonicalText: 'Recovered outbound',
          providerPayload: {
            conversationId: rawTeamsConversationId,
            threadId: 'thread-1',
          },
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: `teams:${rawTeamsConversationId}`,
                threadId: 'thread-1',
                providerId: 'teams',
                providerConnectionId: 'teams_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(expect.objectContaining({ status: 'sent' }));
    expect(channelWiring.sendProviderMessage).toHaveBeenCalledWith(
      `teams:${rawTeamsConversationId}`,
      'Recovered outbound',
      expect.objectContaining({
        throwOnMissing: true,
        messageOptions: { threadId: 'thread-1' },
        permit: expect.objectContaining({
          destinationJid: `teams:${rawTeamsConversationId}`,
          canonicalText: 'Recovered outbound',
        }),
      }),
    );
  });

  it('surfaces retry-tail metadata from recovery dispatch partials without nested message-row writes', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const sendProviderMessage = vi.fn(async () => {
      const partial = new PartialMessageDeliveryError({
        cause: new Error('partial'),
        deliveredChunks: 1,
        totalChunks: 2,
        name: 'PartialSlackDeliveryError',
        message: 'first segment sent',
      });
      Object.assign(partial, {
        deliveredParts: 1,
        totalParts: 2,
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack', segment: 2 },
        },
      });
      throw partial;
    });
    channelWiring.sendProviderMessage = sendProviderMessage as any;
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:slack:partial:1',
          appId: 'default',
          conversationId: 'conversation:provider-connection:slack:C123',
          threadId: 'thread-1',
        },
        item: {
          id: 'delivery-item:slack:partial:1',
          canonicalText: 'Recovered outbound',
          providerPayload: { jid: 'C123', threadId: 'thread-1' },
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'sl:C123',
                threadId: 'thread-1',
                providerId: 'slack',
                providerConnectionId: 'slack_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(channelWiring.sendMessage).not.toHaveBeenCalled();
    expect(sendProviderMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Recovered outbound',
      expect.objectContaining({
        throwOnMissing: true,
        messageOptions: { threadId: 'thread-1' },
        permit: expect.objectContaining({
          deliveryId: 'delivery:slack:partial:1',
          itemId: 'delivery-item:slack:partial:1',
          destinationJid: 'sl:C123',
          canonicalText: 'Recovered outbound',
          threadId: 'thread-1',
        }),
      }),
    );
    expect(dispatchResult).toEqual(
      expect.objectContaining({
        status: 'partially_delivered',
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack' },
        },
      }),
    );
  });

  it('omits mismatched Slack channelId retry-tail metadata during recovery dispatch persistence hints', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const sendProviderMessage = vi.fn(async () => {
      const partial = new PartialMessageDeliveryError({
        cause: new Error('partial'),
        deliveredChunks: 1,
        totalChunks: 2,
        name: 'PartialSlackDeliveryError',
        message: 'first segment sent',
      });
      Object.assign(partial, {
        deliveredParts: 1,
        totalParts: 2,
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: {
            provider: 'slack',
            channelId: 'CWRONG',
            threadId: 'thread-1',
          },
        },
      });
      throw partial;
    });
    channelWiring.sendProviderMessage = sendProviderMessage as any;
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:slack:partial:channel-mismatch',
          appId: 'default',
          conversationId: 'conversation:provider-connection:slack:C123',
          threadId: 'thread-1',
        },
        item: {
          id: 'delivery-item:slack:partial:channel-mismatch',
          canonicalText: 'Recovered outbound',
          providerPayload: {
            jid: 'C123',
            channelId: 'CWRONG',
            threadId: 'thread-1',
          },
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'sl:C123',
                threadId: 'thread-1',
                providerId: 'slack',
                providerConnectionId: 'slack_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(
      expect.objectContaining({
        status: 'partially_delivered',
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: {
            provider: 'slack',
            threadId: 'thread-1',
          },
        },
      }),
    );
    expect(
      (dispatchResult as any).retryTail?.providerPayload,
    ).not.toHaveProperty('channelId');
  });

  it('fails closed when provider destination hints conflict with canonical delivery destination', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:1',
          appId: 'default',
          conversationId: 'conversation:tg:canonical',
          threadId: 'thread-canonical',
        },
        item: {
          id: 'delivery-item:1',
          canonicalText: 'Recovered outbound',
          providerPayload: { jid: 'tg:mismatch', threadId: 'thread-other' },
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'tg:canonical',
                threadId: 'thread-canonical',
                providerId: 'telegram',
                providerConnectionId: 'telegram_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('conflicts with canonical'),
      }),
    );
    expect(channelWiring.sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed when outbound recovery canonical destination has no connected channel', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:1',
          appId: 'default',
          conversationId: 'conversation:tg:missing',
        },
        item: {
          id: 'delivery-item:1',
          canonicalText: 'Recovered outbound',
          providerPayload: { jid: 'tg:missing' },
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'tg:missing',
                providerId: 'telegram',
                providerConnectionId: 'telegram_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('channel'),
      }),
    );
    expect(channelWiring.sendMessage).not.toHaveBeenCalled();
  });

  it('quarantines cross-app external recovery rows instead of dispatching with current app credentials', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const sendProviderMessage = vi.fn(async () => ({
      externalMessageId: '1710000000.000001',
    }));
    channelWiring.sendProviderMessage = sendProviderMessage as any;
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:cross-app:external',
          appId: 'app:other',
          conversationId: 'conversation:provider-connection:other:C999',
        },
        item: {
          id: 'delivery-item:cross-app:external',
          canonicalText: 'cross-app external row',
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

    await startRuntimeServices(
      { app, channelWiring },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'sl:C999',
                providerId: 'slack',
                providerConnectionId: 'provider-connection:other',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(
      expect.objectContaining({
        status: 'partially_delivered',
        error: expect.stringContaining('quarantined cross-app external'),
      }),
    );
    expect(sendProviderMessage).not.toHaveBeenCalled();
  });

  it('allows cross-app recovery dispatch for control graph app session destinations', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const sendProviderMessage = vi.fn(async () => ({
      externalMessageId: 'app-delivery-1',
    }));
    channelWiring.sendProviderMessage = sendProviderMessage as any;
    let dispatchResult: unknown;
    const startOutboundDeliveryRecoveryLoop = vi.fn(({ dispatch }: any) => {
      void dispatch({
        delivery: {
          id: 'delivery:cross-app:internal',
          appId: 'app-other',
          conversationId: 'control:app-other:conversation:conv-1',
        },
        item: {
          id: 'delivery-item:cross-app:internal',
          canonicalText: 'cross-app app-session row',
        },
      }).then((result) => {
        dispatchResult = result;
      });
      return {
        isRunning: () => true,
        stop: async () => {},
      };
    });

    await startRuntimeServices(
      { app, channelWiring },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              resolveDeliveryDestination: vi.fn(async () => ({
                conversationJid: 'app:app-other:conv-1',
                providerId: 'control-http',
                providerConnectionId: 'control:app-other',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchResult).toEqual(
      expect.objectContaining({
        status: 'sent',
        providerMessageId: 'app-delivery-1',
      }),
    );
    expect(sendProviderMessage).toHaveBeenCalledWith(
      'app:app-other:conv-1',
      'cross-app app-session row',
      expect.objectContaining({
        throwOnMissing: true,
      }),
    );
  });

  it('maps app session durable enqueue targets to control graph scope', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const enqueueDelivery = vi.fn(async (input: any) => ({
      created: true,
      delivery: input.delivery,
    }));

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              enqueueDelivery,
              getDelivery: vi.fn(async () => null),
              claimDueDeliveryItems: vi.fn(async () => []),
              resolveDeliveryDestination: vi.fn(async () => null),
              markDeliveryItemSent: vi.fn(async () => ({
                applied: true,
                delivery: null,
              })),
              markDeliveryItemFailed: vi.fn(async () => ({
                applied: true,
                delivery: null,
              })),
              markDeliveryItemPartiallyDelivered: vi.fn(async () => ({
                applied: true,
                delivery: null,
              })),
              listReceiptsForItem: vi.fn(async () => []),
              getReceipt: vi.fn(async () => null),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop: vi.fn(
          () =>
            ({
              isRunning: () => true,
              stop: async () => {},
            }) as any,
        ),
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

    const durableAttemptFactory = vi.mocked(
      channelWiring.setDurableOutboundAttemptFactory,
    ).mock.calls[0]?.[0];
    expect(durableAttemptFactory).toBeDefined();

    await durableAttemptFactory!({
      appId: 'default' as never,
      chatJid: 'app:app-one:conv-1',
      sourceMessageId: 'outbound:test:app-session',
      provider: 'app',
      canonicalText: 'hello app session',
    });

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueDelivery.mock.calls[0]?.[0]?.delivery).toMatchObject({
      appId: 'app-one',
      conversationId: 'control:app-one:conversation:conv-1',
    });
  });

  it('splits required durable live sends above 8000 chars into bounded segments before immediate settlement', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const enqueueDelivery = vi.fn(async (input: any) => ({
      created: true,
      delivery: input.delivery,
    }));
    const markDeliveryItemSent = vi.fn(async () => ({
      applied: true,
      delivery: null,
    }));

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              enqueueDelivery,
              getDelivery: vi.fn(async () => null),
              claimDueDeliveryItems: vi.fn(async () => []),
              resolveDeliveryDestination: vi.fn(async () => null),
              markDeliveryItemSent,
              markDeliveryItemFailed: vi.fn(async () => ({
                applied: true,
                delivery: null,
              })),
              markDeliveryItemPartiallyDelivered: vi.fn(async () => ({
                applied: true,
                delivery: null,
              })),
              listReceiptsForItem: vi.fn(async () => []),
              getReceipt: vi.fn(async () => null),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop: vi.fn(
          () =>
            ({
              isRunning: () => true,
              stop: async () => {},
            }) as any,
        ),
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

    const durableAttemptFactory = vi.mocked(
      channelWiring.setDurableOutboundAttemptFactory,
    ).mock.calls[0]?.[0];
    expect(durableAttemptFactory).toBeDefined();

    const longText = 'x'.repeat(8_001);
    const durableAttempt = await durableAttemptFactory!({
      appId: 'default' as never,
      chatJid: 'tg:primary',
      sourceMessageId: 'outbound:test:large',
      provider: 'telegram',
      canonicalText: longText,
    });

    await expect(
      durableAttempt.settleSent({
        sentAt: '2026-05-08T00:00:00.000Z',
        providerMessageId: 'provider-msg-1',
      }),
    ).resolves.toBeUndefined();

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    const enqueuedItems = enqueueDelivery.mock.calls[0]?.[0]?.items ?? [];
    expect(enqueuedItems).toHaveLength(2);
    expect(enqueuedItems[0]?.canonicalText).toHaveLength(8_000);
    expect(enqueuedItems[1]?.canonicalText).toHaveLength(1);
    expect(markDeliveryItemSent).toHaveBeenCalledTimes(2);
  });

  it('marks remaining split rows non-recoverable when a later sent settlement fails after provider-visible success', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const deliveries = new Map<string, any>();
    const items = new Map<string, any>();
    let recoveryService: any;
    const enqueueDelivery = vi.fn(async (input: any) => {
      deliveries.set(input.delivery.id, { ...input.delivery });
      for (const item of input.items) {
        items.set(item.id, { ...item });
      }
      return {
        created: true,
        delivery: input.delivery,
      };
    });
    const markDeliveryItemSent = vi.fn(async (input: any) => {
      const item = items.get(input.itemId);
      if (!item) return { applied: false, delivery: null };
      if (item.status !== 'claimed' || item.claimToken !== input.claimToken) {
        return { applied: false, delivery: deliveries.get(input.deliveryId) };
      }
      if (item.ordinal === 1) {
        return { applied: false, delivery: deliveries.get(input.deliveryId) };
      }
      item.status = 'sent';
      item.sentAt = input.receipt.sentAt;
      item.claimToken = undefined;
      item.claimExpiresAt = undefined;
      item.failedAt = undefined;
      item.lastError = undefined;
      item.updatedAt = input.receipt.sentAt;
      items.set(item.id, item);
      return { applied: true, delivery: deliveries.get(input.deliveryId) };
    });
    const markDeliveryItemFailed = vi.fn(async (input: any) => {
      const item = items.get(input.itemId);
      if (!item) return { applied: false, delivery: null };
      if (item.status !== 'claimed' || item.claimToken !== input.claimToken) {
        return { applied: false, delivery: deliveries.get(input.deliveryId) };
      }
      item.status = 'failed';
      item.failedAt = input.failedAt;
      item.lastError = input.error;
      item.claimToken = undefined;
      item.claimExpiresAt = undefined;
      item.updatedAt = input.failedAt;
      items.set(item.id, item);
      return { applied: true, delivery: deliveries.get(input.deliveryId) };
    });
    const markDeliveryItemPartiallyDelivered = vi.fn(async (input: any) => {
      const item = items.get(input.itemId);
      if (!item) return { applied: false, delivery: null };
      if (
        item.status === 'partially_delivered' &&
        item.failedAt === input.partialAt &&
        item.lastError === input.error
      ) {
        return { applied: true, delivery: deliveries.get(input.deliveryId) };
      }
      if (item.status !== 'claimed' || item.claimToken !== input.claimToken) {
        return { applied: false, delivery: deliveries.get(input.deliveryId) };
      }
      item.status = 'partially_delivered';
      item.failedAt = input.partialAt;
      item.lastError = input.error;
      item.claimToken = undefined;
      item.claimExpiresAt = undefined;
      item.updatedAt = input.partialAt;
      items.set(item.id, item);
      return { applied: true, delivery: deliveries.get(input.deliveryId) };
    });
    const claimDueDeliveryItems = vi.fn(async (input: any) => {
      const due = Array.from(items.values())
        .filter((item) => {
          const delivery = deliveries.get(item.deliveryId);
          if (!delivery || delivery.appId !== input.appId) return false;
          if (input.profileId && delivery.profileId !== input.profileId) {
            return false;
          }
          if (item.status === 'pending') return true;
          return (
            item.status === 'claimed' &&
            typeof item.claimExpiresAt === 'string' &&
            item.claimExpiresAt <= input.now
          );
        })
        .slice(0, input.limit);
      return due.map((item) => ({
        delivery: deliveries.get(item.deliveryId),
        item: { ...item },
        finalAnswer: null,
      }));
    });

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
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(
          () =>
            ({
              enqueueDelivery,
              getDelivery: vi.fn(
                async (id: string) => deliveries.get(id) ?? null,
              ),
              claimDueDeliveryItems,
              resolveDeliveryDestination: vi.fn(async () => null),
              markDeliveryItemSent,
              markDeliveryItemFailed,
              markDeliveryItemPartiallyDelivered,
              listReceiptsForItem: vi.fn(async () => []),
              getReceipt: vi.fn(async () => null),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop: vi.fn((input: any) => {
          recoveryService = input.service;
          return {
            isRunning: () => true,
            stop: async () => {},
          };
        }) as any,
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

    const durableAttemptFactory = vi.mocked(
      channelWiring.setDurableOutboundAttemptFactory,
    ).mock.calls[0]?.[0];
    expect(durableAttemptFactory).toBeDefined();

    const longText = 'x'.repeat(16_001);
    const durableAttempt = await durableAttemptFactory!({
      appId: 'default' as never,
      chatJid: 'tg:primary',
      sourceMessageId: 'outbound:test:split-sent-failure',
      provider: 'telegram',
      canonicalText: longText,
    });

    await expect(
      durableAttempt.settleSent({
        sentAt: '2026-05-08T00:00:00.000Z',
        providerMessageId: 'provider-msg-visible',
      }),
    ).rejects.toThrow(/not applied/i);

    expect(markDeliveryItemSent).toHaveBeenCalledTimes(2);
    expect(markDeliveryItemPartiallyDelivered).toHaveBeenCalledTimes(2);

    const itemRows = Array.from(items.values()).sort(
      (a, b) => a.ordinal - b.ordinal,
    );
    expect(itemRows).toHaveLength(3);
    expect(itemRows[0]).toMatchObject({
      status: 'sent',
      claimToken: undefined,
      claimExpiresAt: undefined,
    });
    expect(itemRows[1]).toMatchObject({
      status: 'partially_delivered',
      claimToken: undefined,
      claimExpiresAt: undefined,
    });
    expect(itemRows[2]).toMatchObject({
      status: 'partially_delivered',
      claimToken: undefined,
      claimExpiresAt: undefined,
    });

    const dispatch = vi.fn(async () => ({
      status: 'sent' as const,
      providerMessageId: 'should-not-send',
    }));
    const recoveryResult = await runBoundedOutboundDeliveryRecovery({
      service: recoveryService,
      appId: 'default' as never,
      claimerId: 'runtime-recovery:test',
      batchLimit: 5,
      maxBatches: 2,
      leaseMs: 5_000,
      now: () => '2026-05-08T00:10:00.000Z',
      dispatch,
    });
    expect(recoveryResult.claimed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

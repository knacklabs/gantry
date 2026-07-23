import { describe, expect, it, vi } from 'vitest';

import {
  getOldestWaitingLiveAdmissionSeconds,
  shutdownLiveTurnAuthority,
  startRuntimeServices,
  stopLiveAdmissionLoop,
  stopLiveTurnRecoveryLoop,
} from '@core/app/bootstrap/runtime-services.js';
import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import { buildLiveTurnRecoveryCapabilityGate } from '@core/app/bootstrap/live-turn-recovery-capability-gate.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import type { ChannelWiring } from '@core/app/bootstrap/channel-wiring-types.js';
import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import { runBoundedOutboundDeliveryRecovery } from '@core/jobs/outbound-delivery-recovery.js';
import { stopWorkerHeartbeat } from '@core/jobs/worker-identity.js';
import { buildPendingMessagesContinuationIdempotencyKey } from '@core/runtime/pending-message-replay.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '@core/shared/message-cursor.js';
import {
  FakeCoordination,
  FakeLiveTurns,
} from '../application/live-turn-lease-fakes.js';

const startupOrder = vi.hoisted(() => ({
  wireInlineTools: vi.fn(),
  recoverAsyncTasks: vi.fn(),
  startAsyncRecoveryLoop: vi.fn(),
}));

vi.mock(
  '@core/app/bootstrap/inline-agent-loop-tools.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@core/app/bootstrap/inline-agent-loop-tools.js')
      >();
    return {
      ...actual,
      wireInlineAgentLoopTools: (
        ...args: Parameters<typeof actual.wireInlineAgentLoopTools>
      ) => {
        startupOrder.wireInlineTools();
        return actual.wireInlineAgentLoopTools(...args);
      },
    };
  },
);

vi.mock(
  '@core/app/bootstrap/runtime-services-async-task-recovery.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@core/app/bootstrap/runtime-services-async-task-recovery.js')
      >();
    return {
      ...actual,
      recoverStaleAsyncCommandTasks: async (
        ...args: Parameters<typeof actual.recoverStaleAsyncCommandTasks>
      ) => {
        startupOrder.recoverAsyncTasks();
        return actual.recoverStaleAsyncCommandTasks(...args);
      },
      startAsyncTaskRecoveryLoop: (
        ...args: Parameters<typeof actual.startAsyncTaskRecoveryLoop>
      ) => {
        startupOrder.startAsyncRecoveryLoop();
        return actual.startAsyncTaskRecoveryLoop(...args);
      },
    };
  },
);

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
    getPolicy: vi.fn(() => ({
      maxMessageRuns: 3,
      maxJobRuns: 1,
      maxMessageBacklog: 10,
      maxTaskBacklog: 10,
      maxRetries: 3,
      baseRetryMs: 100,
    })),
    setLiveTurnRunnerRegistrar: vi.fn(),
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
    processGroupMessages: vi.fn(async (_queueJid, options) => {
      options?.onRunResult?.('success');
      return true;
    }),
    getConversationRoutes: vi.fn(() => ({
      'tg:primary': {
        name: 'Main',
        folder: 'main',
        trigger: '@M',
        added_at: 't',
      },
    })),
    setAgentCursor: vi.fn(),
  };
}

function makeChannelWiring(): ChannelWiring {
  const createRecoveryDispatchPermit = vi.fn((input: any) => ({
    ...input,
    __permit: 'recovery',
  }));
  return {
    getRuntimeAppId: vi.fn(() => 'default' as never),
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
    setMessageActionHandler: vi.fn(),
    sendStreamingChunk: vi.fn(async () => {}),
    resetStreaming: vi.fn(),
    setTyping: vi.fn(async () => {}),
    sendProgressUpdate: vi.fn(async () => {}),
    addReaction: vi.fn(async () => {}),
    syncGroups: vi.fn(async () => {}),
    requestPermissionApproval: vi.fn(async () => ({ approved: true })),
    requestUserAnswer: vi.fn(async () => ({ requestId: 'q', answers: {} })),
    renderAgentTodo: vi.fn(async () => true),
    finalizeAgentTodo: vi.fn(async () => true),
    disconnectChannels: vi.fn(async () => {}),
    isControlApproverAllowed: vi.fn(async () => true),
  };
}

async function makeConnectedTelegramWiring(
  app: RuntimeApp,
  providerSend: ReturnType<typeof vi.fn>,
): Promise<ChannelWiring> {
  const channelWiring = createChannelWiring(app, {
    providerIds: [
      {
        id: 'telegram',
        label: 'Telegram',
        jidPrefix: 'tg:',
        folderPrefix: 'telegram_',
        isGroupJid: (jid: string) => jid.startsWith('tg:'),
        canStreamToJid: () => false,
        formatting: 'telegram-html',
        isEnabled: () => true,
        create: () => ({
          name: 'telegram',
          connect: vi.fn(async () => undefined),
          sendMessage: providerSend,
          isConnected: vi.fn(() => true),
          ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
          disconnect: vi.fn(async () => undefined),
        }),
        setup: {
          envKeys: [],
          describe: () => 'Telegram',
          run: async () => undefined,
        },
      },
    ],
    opsRepository: {
      storeMessage: vi.fn(async () => undefined),
      storeChatMetadata: vi.fn(async () => undefined),
    },
  });
  await channelWiring.connectEnabledChannels(
    {
      providers: { telegram: { enabled: true } },
      runtime: {
        liveTurns: { enabled: false },
      },
      providerAccounts: {
        telegram_default: {
          agentId: 'agent:main',
          provider: 'telegram',
          label: 'Telegram',
          runtimeSecretRefs: {},
        },
      },
    } as never,
    { providerInbound: false },
  );
  return channelWiring;
}

describe('buildLiveTurnRecoveryCapabilityGate', () => {
  it('uses the conversation route when recovered turn has no queue metadata', async () => {
    const app = makeApp();
    const listAgentSkillBindings = vi.fn(async () => [
      { skillId: 'sk-1', status: 'active' },
    ]);
    const gate = buildLiveTurnRecoveryCapabilityGate({
      app,
      workerCoordination: {
        getWorker: vi.fn(async () => ({ capabilities: [] })),
      } as any,
      liveTurnLeaseDeps: { workerInstanceId: 'worker-new' } as any,
      getDeploymentMode: () => 'fleet',
      getSkillRepository: () => ({ listAgentSkillBindings }) as any,
      agentIdForFolder: (folder) => `agent:${folder}`,
      nowMs: () => 0,
      warn: vi.fn(),
    });

    await expect(
      gate.isEligibleToRecoverLiveTurn({
        appId: 'default',
        conversationId: 'tg:primary',
        threadId: null,
        pendingMessage: null,
      } as any),
    ).resolves.toBe(false);
    expect(listAgentSkillBindings).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:main',
    });
  });

  it('fails closed when the recovery route cannot resolve an owner', async () => {
    const app = makeApp();
    app.getConversationRoutes = vi.fn(() => ({
      'tg:primary::agent:agent%3Aalpha': {
        name: 'Alpha',
        folder: 'alpha',
        trigger: '@A',
        added_at: 't',
      },
      'tg:primary::agent:agent%3Abeta': {
        name: 'Beta',
        folder: 'beta',
        trigger: '@B',
        added_at: 't',
      },
    }));
    const listAgentSkillBindings = vi.fn(async () => [
      { skillId: 'sk-1', status: 'active' },
    ]);
    const gate = buildLiveTurnRecoveryCapabilityGate({
      app,
      workerCoordination: {
        getWorker: vi.fn(async () => ({
          capabilities: ['skill:sk-alpha', 'skill:sk-beta'],
        })),
      } as any,
      liveTurnLeaseDeps: { workerInstanceId: 'worker-new' } as any,
      getDeploymentMode: () => 'fleet',
      getSkillRepository: () => ({ listAgentSkillBindings }) as any,
      agentIdForFolder: (folder) => `agent:${folder}`,
      nowMs: () => 0,
      warn: vi.fn(),
    });

    await expect(
      gate.isEligibleToRecoverLiveTurn({
        appId: 'default',
        conversationId: 'tg:primary',
        threadId: null,
        pendingMessage: null,
      } as any),
    ).resolves.toBe(false);
    await expect(
      gate.isEligibleToRecoverLiveTurn({
        appId: 'default',
        conversationId: 'tg:primary',
        threadId: null,
        pendingMessage: {
          kind: 'message_cursor',
          queueJid: 'tg:stale',
          cursorBefore: 'cursor-before-run',
        },
      } as any),
    ).resolves.toBe(false);
    expect(listAgentSkillBindings).not.toHaveBeenCalled();
  });
});

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
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent-main',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun: vi.fn(async () => 'agent-run:live-1'),
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn(() => {
          order.push('recoverPendingMessages');
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

    // Durable live admission is required. Without the repository dependencies,
    // startup does not start route-wide message scans.
    expect(order).toEqual([
      'startIpcWatcher',
      'startSchedulerLoop',
      'writeGroupsSnapshot',
      'runtime-ready-log',
    ]);
    expect(startupOrder.wireInlineTools).toHaveBeenCalledBefore(
      startupOrder.recoverAsyncTasks,
    );
    expect(startupOrder.recoverAsyncTasks).toHaveBeenCalledBefore(
      startupOrder.startAsyncRecoveryLoop,
    );

    expect((app.queue.setProcessMessagesFn as any).mock.calls).toHaveLength(1);
  });

  it('skips live admission when live turns are disabled', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const startSchedulerLoop = vi.fn();
    const startIpcWatcher = vi.fn();
    const recoverPendingMessages = vi.fn();

    await startRuntimeServices(
      {
        app,
        channelWiring,
        liveTurnsEnabled: false,
      },
      {
        startSchedulerLoop: startSchedulerLoop as any,
        startIpcWatcher: startIpcWatcher as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: recoverPendingMessages as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    expect(startSchedulerLoop).toHaveBeenCalledOnce();
    expect(startIpcWatcher).toHaveBeenCalledOnce();
    expect(recoverPendingMessages).not.toHaveBeenCalled();
    expect(app.queue.setProcessMessagesFn).toHaveBeenCalledOnce();
  });

  it('claims live admission work for the channel wiring app scope', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    (channelWiring.getRuntimeAppId as ReturnType<typeof vi.fn>).mockReturnValue(
      'app-one',
    );
    const claimLiveAdmissionWorkItems = vi.fn(async () => []);

    await startRuntimeServices(
      {
        app,
        channelWiring,
        jobExecution: false,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(
          () =>
            ({
              registerWorker: vi.fn(async () => undefined),
              heartbeatWorker: vi.fn(async () => true),
            }) as any,
        ),
        getLiveTurnRepository: vi.fn(
          () =>
            ({
              claimLiveAdmissionWorkItems,
              renewLiveAdmissionWorkItemClaim: vi.fn(async () => true),
              deferLiveAdmissionWorkItem: vi.fn(async () => true),
              settleLiveAdmissionWorkItem: vi.fn(async () => true),
              listRecoverableLiveTurns: vi.fn(async () => []),
            }) as any,
        ),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    await vi.waitFor(() =>
      expect(claimLiveAdmissionWorkItems).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      ),
    );

    await stopLiveAdmissionLoop(0);
    stopLiveTurnRecoveryLoop();
    await shutdownLiveTurnAuthority();
    stopWorkerHeartbeat();
  });

  it('does not start the scheduler loop when the role has no job execution', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const startSchedulerLoop = vi.fn();

    await startRuntimeServices(
      {
        app,
        channelWiring,
        jobExecution: false,
      },
      {
        startSchedulerLoop: startSchedulerLoop as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );

    expect(startSchedulerLoop).not.toHaveBeenCalled();
  });

  it('starts the scheduler loop when the role runs job execution', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const startSchedulerLoop = vi.fn();

    await startRuntimeServices(
      {
        app,
        channelWiring,
        jobExecution: true,
      },
      {
        startSchedulerLoop: startSchedulerLoop as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );

    expect(startSchedulerLoop).toHaveBeenCalledOnce();
  });

  it('runs durable admission on every live worker and gates only the recovery coordinator on the lease', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    let transitions:
      | {
          onAcquired: (lease: { release: () => Promise<void> }) => void;
          onLost: (err: Error) => void;
        }
      | undefined;
    const recoveryCoordinator = {
      onTransition: vi.fn((handlers: typeof transitions) => {
        transitions = handlers;
      }),
    };
    const startSchedulerLoop = vi.fn();
    const recoverPendingMessages = vi.fn();

    try {
      await startRuntimeServices(
        {
          app,
          channelWiring,
          recoveryCoordinator: recoveryCoordinator as any,
        },
        {
          startSchedulerLoop: startSchedulerLoop as any,
          startIpcWatcher: vi.fn() as any,
          writeGroupsSnapshot: vi.fn() as any,
          opsRepository: {} as any,
          getToolRepository: vi.fn(() => ({}) as any),
          getWorkerCoordinationRepository: vi.fn(() => coordination as any),
          getLiveTurnRepository: vi.fn(() => liveTurns as any),
          recoverPendingMessages: recoverPendingMessages as any,
          logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
          exit: vi.fn() as any,
        },
      );

      expect(startSchedulerLoop).toHaveBeenCalledOnce();
      expect(recoveryCoordinator.onTransition).toHaveBeenCalledOnce();
      expect(recoverPendingMessages).not.toHaveBeenCalled();

      // Acquiring the coordinator lease starts recovery; it does NOT restart
      // admission (already running).
      transitions?.onAcquired({ release: vi.fn(async () => {}) });
      expect(recoverPendingMessages).toHaveBeenCalledOnce();
      const messageLoopDeps = recoverPendingMessages.mock.calls[0]?.[0] as any;
      expect(
        messageLoopDeps.hasChannel('sl:C123', {
          providerAccountId: 'slack_beta',
        }),
      ).toBe(true);
      expect(channelWiring.hasChannel).toHaveBeenCalledWith('sl:C123', {
        providerAccountId: 'slack_beta',
      });

      // Losing the coordinator lease stops recovery but keeps admission running.
      transitions?.onLost(new Error('lease connection ended'));

      // Re-acquisition re-runs recovery; admission is still the one boot loop.
      transitions?.onAcquired({ release: vi.fn(async () => {}) });
      expect(recoverPendingMessages).toHaveBeenCalledTimes(2);
    } finally {
      await stopLiveAdmissionLoop(0);
      stopLiveTurnRecoveryLoop();
      await shutdownLiveTurnAuthority();
      stopWorkerHeartbeat();
    }
  });

  it('does not start the waiting-status monitor in workstation mode', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const getOldestWaitingLiveAdmission = vi.fn(async () => ({
      conversationJid: 'tg:primary',
      threadId: null,
      waitingSince: '2026-06-11T00:00:00.000Z',
      ageSeconds: 42,
    }));
    (liveTurns as any).getOldestWaitingLiveAdmission =
      getOldestWaitingLiveAdmission;

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
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        getDeploymentMode: vi.fn(() => 'workstation' as const),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getOldestWaitingLiveAdmission).not.toHaveBeenCalled();
      expect(getOldestWaitingLiveAdmissionSeconds()).toBe(0);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
      vi.useRealTimers();
    }
  });

  it('graceful drain stops the fleet waiting-status monitor and resets its metrics accessor', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    // The monitor only needs the durable read + the conversation set; back it
    // with a controllable oldest-waiting probe.
    const getOldestWaitingLiveAdmission = vi.fn(async () => ({
      conversationJid: 'tg:primary',
      threadId: null,
      waitingSince: '2026-06-11T00:00:00.000Z',
      ageSeconds: 42,
    }));
    (liveTurns as any).getOldestWaitingLiveAdmission =
      getOldestWaitingLiveAdmission;

    await startRuntimeServices(
      {
        app,
        channelWiring,
        // Single-process embedding: this worker is also the coordinator, so the
        // waiting-status monitor starts immediately at boot.
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        getDeploymentMode: vi.fn(() => 'fleet' as const),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );
    try {
      // Drive one probe so the monitor reports a non-zero oldest-waiting age via
      // the /metrics accessor.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getOldestWaitingLiveAdmission).toHaveBeenCalled();
      expect(getOldestWaitingLiveAdmissionSeconds()).toBe(42);

      // Graceful SIGTERM drain runs this choke point. It must stop the monitor
      // (clearInterval) AND reset the metrics accessor — not only the lease-loss
      // onLost path.
      stopLiveTurnRecoveryLoop();
      expect(getOldestWaitingLiveAdmissionSeconds()).toBe(0);

      const callsAfterStop = getOldestWaitingLiveAdmission.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      // The probe timer was cleared: no further probes fire after the drain.
      expect(getOldestWaitingLiveAdmission.mock.calls.length).toBe(
        callsAfterStop,
      );
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
      vi.useRealTimers();
    }
  });

  it('admits live turns on every worker without a coordinator lease gate', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentId: 'agent-main',
      agentSessionId: 'session-main',
    }));
    const createSessionAgentRun = vi.fn(async () => 'agent-run:live-1');
    await startRuntimeServices(
      {
        app,
        channelWiring,
        recoveryCoordinator: {
          onTransition: () => {},
        } as any,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext,
          createSessionAgentRun,
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      // No lease gate: any live worker admits and processes the turn directly.
      await expect(processMessages('tg:primary')).resolves.toBe(true);
      expect(createSessionAgentRun).toHaveBeenCalledOnce();
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('wires live-turn admission and fenced finalization into message processing', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentId: 'agent-main',
      agentSessionId: 'session-main',
    }));
    const createSessionAgentRun = vi.fn(async () => 'agent-run:live-1');
    app.processGroupMessages = vi.fn(async (_queueJid, options: any) => {
      await options.onLiveStopActionToken?.('stop-token-1');
      options.onRunResult?.('success');
      return true;
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
        opsRepository: {
          getAgentTurnContext,
          createSessionAgentRun,
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      expect(app.queue.setLiveTurnRunnerRegistrar).toHaveBeenCalledOnce();
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      const processed = await processMessages('tg:primary');
      expect(processed).toBe(true);
      expect(getAgentTurnContext).toHaveBeenCalledOnce();
      expect(createSessionAgentRun).toHaveBeenCalledOnce();

      expect(app.processGroupMessages).toHaveBeenCalledWith(
        'tg:primary',
        expect.objectContaining({
          queued: true,
          existingRunId: 'agent-run:live-1',
          existingRunLeaseToken: 'lease-1',
          existingRunLeaseWorkerInstanceId: expect.any(String),
          existingRunLeaseFencingVersion: 1,
          onRunResult: expect.any(Function),
          onFirstProgress: expect.any(Function),
          onLiveStopActionToken: expect.any(Function),
        }),
      );
      const runOptions = vi.mocked(app.processGroupMessages).mock
        .calls[0]?.[1] as any;
      await runOptions?.onFirstProgress?.({
        jid: 'tg:primary',
        messageRef: 'message-1',
      });
      expect(channelWiring.addReaction).toHaveBeenCalledWith(
        'tg:primary',
        'message-1',
        'seen',
        undefined,
      );
      expect([...liveTurns.turns.values()]).toEqual([
        expect.objectContaining({
          appId: 'default',
          agentSessionId: 'session-main',
          conversationId: 'tg:primary',
          runId: 'agent-run:live-1',
          state: 'completed',
          stopAliasJids: ['stop-token-1'],
        }),
      ]);
      expect(coordination.leases).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
      expect(liveTurns.agentRunCompletions).toEqual([
        {
          runId: 'agent-run:live-1',
          status: 'completed',
          resultSummary: 'Live turn completed.',
        },
      ]);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('uses the selected agent route for an agent-qualified live queue key', async () => {
    const app = makeApp();
    app.getConversationRoutes = vi.fn(() => ({
      'tg:primary::agent:agent%3Aalpha': {
        name: 'Alpha',
        folder: 'alpha',
        trigger: '@A',
        added_at: 't',
      },
      'tg:primary::agent:agent%3Abeta': {
        name: 'Beta',
        folder: 'beta',
        trigger: '@B',
        added_at: 't',
      },
    }));
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentSessionId: 'session-beta',
    }));

    await startRuntimeServices(
      { app, channelWiring },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext,
          createSessionAgentRun: vi.fn(async () => 'agent-run:beta'),
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await processMessages('tg:primary::agent:agent%3Abeta');

      expect(getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({ agentFolder: 'beta' }),
      );
      expect(app.processGroupMessages).toHaveBeenCalledWith(
        'tg:primary::agent:agent%3Abeta',
        expect.any(Object),
      );
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('finalizes the live todo card as failed from host turn outcome', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    app.processGroupMessages = vi.fn(
      async (_queueJid: string, options: any) => {
        await channelWiring.renderAgentTodo('tg:primary', {
          summary: 'Plan done',
          status: 'done',
          items: [{ id: 'step-1', title: 'Work', status: 'completed' }],
        });
        options.onRunResult?.('error');
        return true;
      },
    );

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun: vi.fn(async () => 'agent-run:live-1'),
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await expect(processMessages('tg:primary')).resolves.toBe(false);

      expect(channelWiring.renderAgentTodo).toHaveBeenCalledWith(
        'tg:primary',
        expect.objectContaining({ status: 'done' }),
      );
      expect(channelWiring.finalizeAgentTodo).toHaveBeenCalledWith(
        'tg:primary',
        {
          threadId: null,
          status: 'failed',
        },
        undefined,
      );
      expect([...liveTurns.turns.values()]).toEqual([
        expect.objectContaining({
          conversationId: 'tg:primary',
          runId: 'agent-run:live-1',
          state: 'failed',
        }),
      ]);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('settles host stop outcome as handled terminal cancellation', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    app.processGroupMessages = vi.fn(
      async (_queueJid: string, options: any) => {
        await channelWiring.renderAgentTodo('tg:primary', {
          summary: 'Plan running',
          status: 'running',
          stop: { label: 'Stop', actionToken: 'stop-token-1' },
          items: [{ id: 'step-1', title: 'Work', status: 'inProgress' }],
        });
        options.onRunResult?.('stopped');
        return true;
      },
    );

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun: vi.fn(async () => 'agent-run:live-1'),
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await expect(processMessages('tg:primary')).resolves.toBe(true);

      expect(channelWiring.finalizeAgentTodo).toHaveBeenCalledWith(
        'tg:primary',
        {
          threadId: null,
          status: 'stopped',
        },
        undefined,
      );
      expect([...liveTurns.turns.values()]).toEqual([
        expect.objectContaining({
          conversationId: 'tg:primary',
          runId: 'agent-run:live-1',
          state: 'completed',
        }),
      ]);
      expect(coordination.leases).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
      expect(liveTurns.agentRunCompletions).toEqual([
        {
          runId: 'agent-run:live-1',
          status: 'canceled',
          errorSummary: 'Live turn stopped by request.',
        },
      ]);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('returns false when live-turn finalization leaves pending commands for another owner', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    app.processGroupMessages = vi.fn(async () => {
      const turn = [...liveTurns.turns.values()][0];
      await liveTurns.appendLiveTurnCommand({
        id: 'cmd-pending',
        liveTurnId: turn.id,
        commandType: 'continuation',
        idempotencyKey: 'continuation:pending',
        payload: { text: 'follow-up' },
      });
      return true;
    });

    await startRuntimeServices(
      {
        app,
        channelWiring,
        syncGroups: vi.fn(async () => {}),
        startOutboundDeliveryRecoveryLoop: vi.fn(),
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun: vi.fn(async () => 'agent-run:live-1'),
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await expect(processMessages('tg:primary')).resolves.toBe(false);
      expect(liveTurns.commands[0]).toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
      expect([...liveTurns.turns.values()][0]).toEqual(
        expect.objectContaining({ state: 'claimed' }),
      );
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('routes a follow-up to the active owner without minting an orphan run (pre-check)', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    await liveTurns.claimLiveTurn({
      id: 'turn-existing',
      scope: {
        appId: 'default',
        agentSessionId: 'session-main',
        conversationId: 'tg:primary',
        threadId: null,
      },
      workerInstanceId: 'worker-other',
      runId: 'agent-run:other',
    });
    const completeSessionAgentRun = vi.fn(async () => undefined);
    const createSessionAgentRun = vi.fn(async () => 'agent-run:live-1');

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent-main',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun,
          completeSessionAgentRun,
          getMessagesSince: vi.fn(async () => [
            {
              id: 'msg-follow-up',
              chat_jid: 'tg:primary',
              sender: 'user-other',
              sender_name: 'Other',
              content: 'same follow-up',
              timestamp: 'cursor-after-follow-up',
            },
          ]),
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await expect(processMessages('tg:primary')).resolves.toBe(true);
      expect(app.processGroupMessages).not.toHaveBeenCalled();
      // Pre-check short-circuit: no run row is created, so there is nothing to
      // terminal-mark — the orphan is avoided entirely, not cleaned up.
      expect(createSessionAgentRun).not.toHaveBeenCalled();
      expect(completeSessionAgentRun).not.toHaveBeenCalled();
      expect(app.setAgentCursor).toHaveBeenCalledWith(
        'tg:primary',
        JSON.stringify({
          timestamp: 'cursor-after-follow-up',
          id: 'msg-follow-up',
        }),
      );
      expect(liveTurns.commands).toEqual([
        expect.objectContaining({
          liveTurnId: 'turn-existing',
          commandType: 'continuation',
          idempotencyKey: buildPendingMessagesContinuationIdempotencyKey({
            queueJid: 'tg:primary',
            sinceCursor: '',
            cursorAfter: JSON.stringify({
              timestamp: 'cursor-after-follow-up',
              id: 'msg-follow-up',
            }),
            messages: [{ id: 'msg-follow-up' }],
          }),
          payload: expect.objectContaining({
            text: expect.stringContaining('same follow-up'),
          }),
        }),
      ]);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('queues active /compact for later command processing without live continuation injection', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    await liveTurns.claimLiveTurn({
      id: 'turn-existing',
      scope: {
        appId: 'default',
        agentSessionId: 'session-main',
        conversationId: 'tg:primary',
        threadId: null,
      },
      workerInstanceId: 'worker-other',
      runId: 'agent-run:other',
    });
    const compactMessage = {
      id: 'msg-compact',
      chat_jid: 'tg:primary',
      sender: 'user-owner',
      sender_name: 'Owner',
      content: '/compact',
      timestamp: 'cursor-after-compact',
      is_from_me: true,
    };
    const compactCursor = encodeGroupMessageCursor(
      toGroupMessageCursor(compactMessage),
    );
    let cursor = '';
    app.getOrRecoverCursor = vi.fn(async () => cursor);
    app.setAgentCursor = vi.fn((_queueJid: string, nextCursor: string) => {
      cursor = nextCursor;
    });
    const getMessagesSince = vi.fn(async (_chatJid: string, since: string) =>
      since === compactCursor ? [] : [compactMessage],
    );

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent-main',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun: vi.fn(async () => 'agent-run:live-1'),
          getMessagesSince,
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await expect(processMessages('tg:primary')).resolves.toBe(true);
      await expect(processMessages('tg:primary')).resolves.toBe(false);
      expect(liveTurns.commands).toHaveLength(0);
      expect(app.queue.sendMessage).not.toHaveBeenCalled();
      expect(app.queue.closeStdin).not.toHaveBeenCalled();
      expect(app.setAgentCursor).toHaveBeenCalledWith(
        'tg:primary',
        compactCursor,
      );
      expect(app.saveState).toHaveBeenCalledOnce();
      expect(getMessagesSince).toHaveBeenLastCalledWith(
        'tg:primary',
        compactCursor,
        expect.any(Number),
        { threadId: null, providerAccountId: undefined },
      );
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledTimes(1);
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledWith('tg:primary');
      expect(channelWiring.sendMessage).toHaveBeenCalledWith(
        'tg:primary',
        "Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.",
        { durability: 'required' },
      );
      expect(channelWiring.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('cancels the precreated run on live-turn capacity deferral', async () => {
    const app = makeApp();
    vi.mocked(app.queue.getPolicy as any).mockReturnValue({
      maxMessageRuns: 0,
      maxJobRuns: 1,
      maxMessageBacklog: 10,
      maxTaskBacklog: 10,
      maxRetries: 3,
      baseRetryMs: 100,
    });
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const completeSessionAgentRun = vi.fn(async () => undefined);

    await startRuntimeServices(
      {
        app,
        channelWiring,
      },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent-main',
            agentSessionId: 'session-main',
          })),
          createSessionAgentRun: vi.fn(async () => 'agent-run:live-1'),
          completeSessionAgentRun,
        } as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      const processMessages = vi.mocked(app.queue.setProcessMessagesFn as any)
        .mock.calls[0]?.[0] as (queueJid: string) => Promise<boolean>;

      await expect(processMessages('tg:primary')).resolves.toBe(false);
      expect(app.processGroupMessages).not.toHaveBeenCalled();
      expect(completeSessionAgentRun).toHaveBeenCalledWith({
        runId: 'agent-run:live-1',
        status: 'canceled',
        errorSummary: 'Live-turn admission did not claim the run: no_capacity',
      });
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
    }
  });

  it('fails recovered live turns closed when no replayable pending message exists', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const oldLease = await coordination.claimRunLease({
      runId: 'agent-run:lost',
      workerInstanceId: 'worker-old',
      ttlMs: 60_000,
    });
    if (!oldLease) throw new Error('expected old lease');
    coordination.expireLease(oldLease.leaseToken);
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-lost',
      scope: {
        appId: 'default',
        agentSessionId: null,
        conversationId: 'tg:primary',
        threadId: null,
      },
      workerInstanceId: 'worker-old',
      runId: 'agent-run:lost',
    });
    if (!turn) throw new Error('expected turn');
    turn.state = 'running';
    turn.leaseToken = oldLease.leaseToken;
    turn.fencingVersion = oldLease.fencingVersion;
    turn.workerInstanceId = oldLease.workerInstanceId;
    liveTurns.recoverableIds.add(turn.id);

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
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);

      expect(app.queue.enqueueMessageCheck).not.toHaveBeenCalled();
      expect(liveTurns.turns.get('turn-lost')?.state).toBe('failed');
      expect(coordination.leases).toContainEqual(
        expect.objectContaining({
          runId: 'agent-run:lost',
          fencingVersion: 2,
          status: 'failed',
        }),
      );
      expect(liveTurns.agentRunCompletions).toEqual([
        {
          runId: 'agent-run:lost',
          status: 'failed',
          errorSummary:
            'Recovered live turn had no replayable pending message.',
        },
      ]);
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
      vi.useRealTimers();
    }
  });

  it('restores the replay cursor before enqueueing a recovered live turn', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
    });
    liveTurns.coordination = coordination;
    const oldLease = await coordination.claimRunLease({
      runId: 'agent-run:lost',
      workerInstanceId: 'worker-old',
      ttlMs: 60_000,
    });
    if (!oldLease) throw new Error('expected old lease');
    coordination.expireLease(oldLease.leaseToken);
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-lost',
      scope: {
        appId: 'default',
        agentSessionId: null,
        conversationId: 'tg:primary',
        threadId: null,
      },
      workerInstanceId: 'worker-old',
      runId: 'agent-run:lost',
      pendingMessage: {
        kind: 'message_cursor',
        queueJid: 'tg:primary',
        cursorBefore: 'cursor-before-run',
      },
    });
    if (!turn) throw new Error('expected turn');
    turn.state = 'running';
    turn.leaseToken = oldLease.leaseToken;
    turn.fencingVersion = oldLease.fencingVersion;
    turn.workerInstanceId = oldLease.workerInstanceId;
    await liveTurns.appendLiveTurnCommand({
      id: 'cmd-continuation',
      liveTurnId: turn.id,
      commandType: 'continuation',
      idempotencyKey: 'continuation:lost-owner',
      payload: {
        queueJid: 'tg:primary',
        text: 'same follow-up',
        cursorAfter: JSON.stringify({
          timestamp: 'cursor-after-follow-up',
          id: 'msg-follow-up',
        }),
      },
    });
    await liveTurns.appendLiveTurnCommand({
      id: 'cmd-stop',
      liveTurnId: turn.id,
      commandType: 'stop',
      idempotencyKey: 'stop:lost-owner',
    });
    liveTurns.recoverableIds.add(turn.id);

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
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        recoverPendingMessages: vi.fn() as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);

      expect(app.setAgentCursor).toHaveBeenCalledWith(
        'tg:primary',
        'cursor-before-run',
      );
      expect(app.saveState).toHaveBeenCalled();
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledWith('tg:primary');
      expect(liveTurns.turns.get('turn-lost')?.state).toBe('recovered');
      expect(liveTurns.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'cmd-continuation',
            status: 'applied',
            rejectedReason: null,
          }),
          expect.objectContaining({
            id: 'cmd-stop',
            status: 'pending',
          }),
        ]),
      );
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
      vi.useRealTimers();
    }
  });

  it('fleet recovery holds capability-ineligible turns and alerts when no recoverer is eligible', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
      // This worker advertises nothing; the turn's agent requires skill:sk-1.
      getWorker: vi.fn(async () => ({ capabilities: [] })),
      // No active worker in the fleet advertises it either.
      listActiveWorkerCapabilities: vi.fn(async () => []),
    });
    liveTurns.coordination = coordination;
    const publishRuntimeEvent = vi.fn(async () => {});
    const oldLease = await coordination.claimRunLease({
      runId: 'agent-run:lost',
      workerInstanceId: 'worker-old',
      ttlMs: 60_000,
    });
    if (!oldLease) throw new Error('expected old lease');
    coordination.expireLease(oldLease.leaseToken);
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-lost',
      scope: {
        appId: 'default',
        agentSessionId: null,
        conversationId: 'tg:primary',
        threadId: null,
      },
      workerInstanceId: 'worker-old',
      runId: 'agent-run:lost',
      pendingMessage: {
        kind: 'message_cursor',
        queueJid: 'tg:primary',
        cursorBefore: 'cursor-before-run',
      },
    });
    if (!turn) throw new Error('expected turn');
    turn.state = 'running';
    turn.leaseToken = oldLease.leaseToken;
    turn.fencingVersion = oldLease.fencingVersion;
    turn.workerInstanceId = oldLease.workerInstanceId;
    liveTurns.recoverableIds.add(turn.id);

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
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        getDeploymentMode: vi.fn(() => 'fleet' as const),
        getSkillRepository: vi.fn(
          () =>
            ({
              listAgentSkillBindings: vi.fn(async () => [
                { skillId: 'sk-1', status: 'active' },
              ]),
            }) as any,
        ),
        publishRuntimeEvent,
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);

      // The ineligible worker held the turn: no takeover, no resume.
      expect(liveTurns.turns.get('turn-lost')?.state).toBe('running');
      expect(app.queue.enqueueMessageCheck).not.toHaveBeenCalled();
      // "Recoverable but no eligible recoverer" fired the starvation alert.
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            kind: 'capability_starvation',
            cause: 'no_eligible_recoverer',
            key: 'turn-lost',
            required_capabilities: ['skill:sk-1'],
            missing_capabilities: ['skill:sk-1'],
          }),
        }),
      );
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
      vi.useRealTimers();
    }
  });

  it('workstation recovery is unchanged by the capability gate', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    const liveTurns = new FakeLiveTurns();
    const coordination = Object.assign(new FakeCoordination(), {
      registerWorker: vi.fn(async () => {}),
      heartbeatWorker: vi.fn(async () => true),
      // Would be ineligible IF the fleet gate ran: empty advertised set.
      getWorker: vi.fn(async () => ({ capabilities: [] })),
      listActiveWorkerCapabilities: vi.fn(async () => []),
    });
    liveTurns.coordination = coordination;
    const publishRuntimeEvent = vi.fn(async () => {});
    const oldLease = await coordination.claimRunLease({
      runId: 'agent-run:lost',
      workerInstanceId: 'worker-old',
      ttlMs: 60_000,
    });
    if (!oldLease) throw new Error('expected old lease');
    coordination.expireLease(oldLease.leaseToken);
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-lost',
      scope: {
        appId: 'default',
        agentSessionId: null,
        conversationId: 'tg:primary',
        threadId: null,
      },
      workerInstanceId: 'worker-old',
      runId: 'agent-run:lost',
      pendingMessage: {
        kind: 'message_cursor',
        queueJid: 'tg:primary',
        cursorBefore: 'cursor-before-run',
      },
    });
    if (!turn) throw new Error('expected turn');
    turn.state = 'running';
    turn.leaseToken = oldLease.leaseToken;
    turn.fencingVersion = oldLease.fencingVersion;
    turn.workerInstanceId = oldLease.workerInstanceId;
    liveTurns.recoverableIds.add(turn.id);

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
        getWorkerCoordinationRepository: vi.fn(() => coordination as any),
        getLiveTurnRepository: vi.fn(() => liveTurns as any),
        getDeploymentMode: vi.fn(() => 'workstation' as const),
        getSkillRepository: vi.fn(
          () =>
            ({
              listAgentSkillBindings: vi.fn(async () => [
                { skillId: 'sk-1', status: 'active' },
              ]),
            }) as any,
        ),
        publishRuntimeEvent,
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);

      // Single-host behavior unchanged: the turn is recovered and re-enqueued.
      expect(liveTurns.turns.get('turn-lost')?.state).toBe('recovered');
      expect(app.queue.enqueueMessageCheck).toHaveBeenCalledWith('tg:primary');
      // The gate never consulted capabilities and no starvation alert fired.
      expect(coordination.getWorker).not.toHaveBeenCalled();
      expect(publishRuntimeEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ kind: 'capability_starvation' }),
        }),
      );
    } finally {
      stopLiveTurnRecoveryLoop();
      await stopLiveAdmissionLoop(0);
      await shutdownLiveTurnAuthority();
      vi.useRealTimers();
    }
  });

  it('installs durable outbound delivery before IPC and scheduler startup', async () => {
    const order: string[] = [];
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    let ipcDeps: any;
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
        startIpcWatcher: vi.fn((deps) => {
          ipcDeps = deps;
          order.push('startIpcWatcher');
        }) as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        getOutboundDeliveryRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
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
      'setDurableOutboundAttemptFactory',
      'startOutboundDeliveryRecoveryLoop',
      'startIpcWatcher',
      'startSchedulerLoop',
    ]);

    await ipcDeps.sendMessage('tg:primary', 'durable', {
      threadId: '42',
    });
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:primary',
      'durable',
      {
        durability: 'required',
        throwOnMissing: true,
        messageOptions: { threadId: '42' },
      },
    );
  });

  it('persists IPC sends and leaves provider failures retryable', async () => {
    const order: string[] = [];
    const app = makeApp();
    const providerSend = vi.fn(async () => {
      order.push('providerSend');
      throw new Error('provider unavailable');
    });
    const channelWiring = await makeConnectedTelegramWiring(app, providerSend);
    let ipcDeps: any;
    let queuedDelivery: any;
    let queuedItem: any;
    const enqueueDelivery = vi.fn(async (input: any) => {
      order.push('enqueueDelivery');
      queuedDelivery = input.delivery;
      queuedItem = { ...input.items[0] };
      return { created: true, delivery: input.delivery };
    });
    const markDeliveryItemFailed = vi.fn(async (input: any) => {
      order.push('markDeliveryItemFailed');
      queuedItem = {
        ...queuedItem,
        status:
          queuedItem.attemptCount < input.maxAttempts ? 'pending' : 'failed',
        claimToken: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: '2026-07-17T00:00:01.000Z',
      };
      return { applied: true, delivery: queuedDelivery };
    });

    try {
      await startRuntimeServices(
        { app, channelWiring },
        {
          startSchedulerLoop: vi.fn() as any,
          startIpcWatcher: vi.fn((deps) => {
            ipcDeps = deps;
          }) as any,
          writeGroupsSnapshot: vi.fn() as any,
          opsRepository: {} as any,
          getToolRepository: vi.fn(() => ({}) as any),
          getOutboundDeliveryRepository: vi.fn(
            () =>
              ({
                enqueueDelivery,
                markDeliveryItemFailed,
              }) as any,
          ),
          recoverPendingMessages: vi.fn() as any,
          startOutboundDeliveryRecoveryLoop: vi.fn() as any,
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
            fatal: vi.fn(),
          },
          exit: vi.fn() as any,
        },
      );

      await expect(
        ipcDeps.sendMessage('tg:primary', 'retry me'),
      ).rejects.toThrow('provider unavailable');

      expect(order).toEqual([
        'enqueueDelivery',
        'providerSend',
        'markDeliveryItemFailed',
      ]);
      expect(enqueueDelivery).toHaveBeenCalledOnce();
      expect(markDeliveryItemFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          maxAttempts: 4,
          retryBaseDelayMs: 1_000,
          retryMaxDelayMs: 30_000,
        }),
      );
      expect(queuedItem).toMatchObject({
        status: 'pending',
        attemptCount: 1,
        claimToken: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: '2026-07-17T00:00:01.000Z',
      });
    } finally {
      await channelWiring.disconnectChannels();
    }
  });

  it('fails closed for required IPC sends without outbound storage', async () => {
    const app = makeApp();
    const providerSend = vi.fn(async () => undefined);
    const channelWiring = await makeConnectedTelegramWiring(app, providerSend);
    let ipcDeps: any;

    try {
      await startRuntimeServices(
        { app, channelWiring },
        {
          startSchedulerLoop: vi.fn() as any,
          startIpcWatcher: vi.fn((deps) => {
            ipcDeps = deps;
          }) as any,
          writeGroupsSnapshot: vi.fn() as any,
          opsRepository: {} as any,
          getToolRepository: vi.fn(() => ({}) as any),
          recoverPendingMessages: vi.fn() as any,
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
            fatal: vi.fn(),
          },
          exit: vi.fn() as any,
        },
      );

      await expect(
        ipcDeps.sendMessage('tg:primary', 'must persist'),
      ).rejects.toThrow(/Durable outbound delivery is required/);
      expect(providerSend).not.toHaveBeenCalled();
    } finally {
      await channelWiring.disconnectChannels();
    }
  });

  it('wires durable scheduler sends', async () => {
    let schedulerDeps:
      import('@core/jobs/scheduler.js').SchedulerDependencies | undefined;
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
        throwOnMissing: true,
        messageOptions: { threadId: 'thread-42' },
      },
    );
  });

  it('scopes scheduler sends to the resolved provider account', async () => {
    let schedulerDeps:
      import('@core/jobs/scheduler.js').SchedulerDependencies | undefined;
    const app = makeApp();
    app.getConversationRoutes = vi.fn(() => ({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:beta',
        'thread-42',
        'slack_beta',
      )]: {
        name: 'Beta',
        folder: 'beta',
        trigger: '@B',
        added_at: 't',
        providerAccountId: 'slack_beta',
      },
    }));
    const channelWiring = makeChannelWiring();

    await startRuntimeServices(
      { app, channelWiring },
      {
        startSchedulerLoop: vi.fn((deps) => {
          schedulerDeps = deps;
        }) as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );

    await schedulerDeps?.sendMessage('sl:C123', 'scheduler output', {
      threadId: 'thread-42',
    });

    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'scheduler output',
      {
        durability: 'required',
        throwOnMissing: true,
        messageOptions: {
          threadId: 'thread-42',
          providerAccountId: 'slack_beta',
        },
      },
    );
  });

  it('routes live stop message actions through the active thread queue', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
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
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    const handler = vi.mocked(channelWiring.setMessageActionHandler).mock
      .calls[0]?.[0];
    expect(handler).toBeDefined();
    await handler?.({
      kind: 'live_turn_stop',
      conversationJid: 'tg:primary',
      threadId: 'topic-42',
      userId: 'user',
      actionToken: '67ad9359-9a43-4fb7-a782-c21a5ef9442a',
    });

    expect(app.queue.stopGroup).toHaveBeenCalledWith(
      '67ad9359-9a43-4fb7-a782-c21a5ef9442a',
    );
    expect(channelWiring.isControlApproverAllowed).toHaveBeenCalledWith({
      conversationJid: 'tg:primary',
      userId: 'user',
      sourceAgentFolder: 'main',
      decisionPolicy: 'same_channel',
    });
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'tg:primary',
      'Stopping current run.',
      { durability: 'required', messageOptions: { threadId: 'topic-42' } },
    );
  });

  it('scopes message actions to the originating provider account', async () => {
    const app = makeApp();
    app.getConversationRoutes = vi.fn(() => ({
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', null, 'slack-alpha')]:
        {
          name: 'Alpha',
          folder: 'alpha',
          trigger: '@A',
          added_at: 't',
          providerAccountId: 'slack-alpha',
        },
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta', null, 'slack-beta')]: {
        name: 'Beta',
        folder: 'beta',
        trigger: '@B',
        added_at: 't',
        providerAccountId: 'slack-beta',
      },
    }));
    const channelWiring = makeChannelWiring();
    vi.mocked(app.queue.stopGroup as any).mockReturnValue(true);

    await startRuntimeServices(
      { app, channelWiring },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );

    const handler = vi.mocked(channelWiring.setMessageActionHandler).mock
      .calls[0]?.[0];
    await handler?.({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      providerAccountId: 'slack-beta',
      userId: 'user',
    });

    expect(channelWiring.isControlApproverAllowed).toHaveBeenCalledWith({
      conversationJid: 'sl:C123',
      providerAccountId: 'slack-beta',
      userId: 'user',
      sourceAgentFolder: 'beta',
      decisionPolicy: 'same_channel',
    });
    expect(app.queue.stopGroup).toHaveBeenCalledWith(
      makeAgentThreadQueueKey('sl:C123', 'agent:beta', null, 'slack-beta'),
    );
    expect(channelWiring.sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Stopping current run.',
      {
        durability: 'required',
        messageOptions: { providerAccountId: 'slack-beta' },
      },
    );
  });

  it('does not fall back to the active thread queue when a live stop token is stale', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    vi.mocked(app.queue.stopGroup as any).mockReturnValue(false);

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
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          fatal: vi.fn(),
        },
        exit: vi.fn() as any,
      },
    );

    const handler = vi.mocked(channelWiring.setMessageActionHandler).mock
      .calls[0]?.[0];
    await handler?.({
      kind: 'live_turn_stop',
      conversationJid: 'tg:primary',
      threadId: 'topic-42',
      userId: 'user',
      actionToken: '67ad9359-9a43-4fb7-a782-c21a5ef9442a',
    });

    expect(app.queue.stopGroup).toHaveBeenNthCalledWith(
      1,
      '67ad9359-9a43-4fb7-a782-c21a5ef9442a',
    );
    expect(app.queue.stopGroup).toHaveBeenCalledTimes(1);
    expect(channelWiring.sendMessage).not.toHaveBeenCalledWith(
      'tg:primary',
      'Stopping current run.',
      expect.any(Object),
    );
  });

  it('does not stop live runs from unapproved message action callbacks', async () => {
    const app = makeApp();
    const channelWiring = makeChannelWiring();
    vi.mocked(channelWiring.isControlApproverAllowed).mockResolvedValue(false);
    vi.mocked(app.queue.stopGroup as any).mockReturnValue(true);

    await startRuntimeServices(
      { app, channelWiring },
      {
        startSchedulerLoop: vi.fn() as any,
        startIpcWatcher: vi.fn() as any,
        writeGroupsSnapshot: vi.fn() as any,
        opsRepository: {} as any,
        getToolRepository: vi.fn(() => ({}) as any),
        recoverPendingMessages: vi.fn() as any,
        logger: { info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
        exit: vi.fn() as any,
      },
    );

    const handler = vi.mocked(channelWiring.setMessageActionHandler).mock
      .calls[0]?.[0];
    await handler?.({
      kind: 'live_turn_stop',
      conversationJid: 'tg:primary',
      threadId: 'topic-42',
      userId: 'user',
    });

    expect(app.queue.stopGroup).not.toHaveBeenCalled();
    expect(channelWiring.sendMessage).not.toHaveBeenCalledWith(
      'tg:primary',
      'Stopping current run.',
      expect.any(Object),
    );
  });

  it('does not refresh job snapshots on scheduler changes', async () => {
    let schedulerDeps:
      import('@core/jobs/scheduler.js').SchedulerDependencies | undefined;
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
                providerAccountId: 'telegram_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
        messageOptions: expect.objectContaining({
          providerAccountId: 'telegram_default',
          threadId: 'thread-1',
        }),
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
                providerAccountId: 'slack_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
        messageOptions: expect.objectContaining({
          providerAccountId: 'slack_default',
          threadId: 'thread-1',
        }),
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
                providerAccountId: 'teams_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
        messageOptions: expect.objectContaining({
          providerAccountId: 'teams_default',
          threadId: 'thread-1',
        }),
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
        provider: 'slack',
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
                providerAccountId: 'slack_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
        messageOptions: expect.objectContaining({
          providerAccountId: 'slack_default',
          threadId: 'thread-1',
        }),
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
        provider: 'slack',
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
                providerAccountId: 'slack_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
                providerAccountId: 'telegram_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
                providerAccountId: 'telegram_default',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
                providerAccountId: 'provider-account:other',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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
                providerId: 'app',
                providerAccountId: 'control:app-other',
              })),
            }) as any,
        ),
        startOutboundDeliveryRecoveryLoop:
          startOutboundDeliveryRecoveryLoop as any,
        recoverPendingMessages: vi.fn() as any,
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

  it('maps provider-account durable enqueue targets to scoped conversation and thread ids', async () => {
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
      chatJid: 'sl:C123',
      threadId: '171.123',
      providerAccountId: 'slack_beta',
      sourceMessageId: 'outbound:test:scoped-account',
      provider: 'slack',
      canonicalText: 'hello slack',
    });

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueDelivery.mock.calls[0]?.[0]?.delivery).toMatchObject({
      appId: 'default',
      conversationId: 'conversation:slack_beta:sl:C123',
      threadId: 'thread:slack_beta:sl:C123:171.123',
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

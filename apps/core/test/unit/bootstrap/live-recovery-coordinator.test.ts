import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_RECOVERY_COORDINATOR_LEASE_KEY,
  liveTurnScopeForQueue,
  routeScopeActiveLiveTurnAdmission,
  routeScopeActiveLiveTurnAdmissionFromCursor,
  startLiveRecoveryCoordinatorLeaseAcquisition,
} from '@core/app/bootstrap/live-recovery-coordinator.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

interface ScheduledTimer {
  fn: () => void;
}

/** Deterministic setTimeout stub: collects callbacks instead of firing them. */
function makeTimerHarness() {
  const scheduled: ScheduledTimer[] = [];
  const setTimeoutFn = ((fn: () => void) => {
    const timer = { fn };
    scheduled.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((timer: unknown) => {
    const index = scheduled.findIndex((entry) => entry === timer);
    if (index >= 0) scheduled.splice(index, 1);
  }) as unknown as typeof clearTimeout;
  const fireNext = (): void => {
    const next = scheduled.shift();
    next?.fn();
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fireNext,
    pendingCount: () => scheduled.length,
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

describe('live-turn host lease acquisition', () => {
  it('skips the host lease when live turns are disabled', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    runtimeSettings.runtime.liveTurns.enabled = false;
    const tryAcquire = vi.fn();

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
    });

    await expect(manager.whenAcquired()).resolves.toBeUndefined();
    expect(manager.getLease()).toBeUndefined();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('skips the host lease when the process role has no live execution', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const tryAcquire = vi.fn();

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      liveExecutionEnabled: false,
    });

    await expect(manager.whenAcquired()).resolves.toBeUndefined();
    expect(manager.getLease()).toBeUndefined();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('acquires the single live-turn host lease by default', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const lease = { release: vi.fn() };
    const tryAcquire = vi.fn(async () => lease);

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: { logger: silentLogger },
    });

    await expect(manager.whenAcquired()).resolves.toBe(lease);
    expect(manager.getLease()).toBe(lease);
    expect(tryAcquire).toHaveBeenCalledWith(
      LIVE_RECOVERY_COORDINATOR_LEASE_KEY,
    );
  });

  it('does not crash when another runtime owns live turns: stands by and takes over after release', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const lease = { release: vi.fn() };
    const tryAcquire = vi
      .fn<[], Promise<typeof lease | undefined>>()
      .mockResolvedValueOnce(undefined) // contended: another runtime owns it
      .mockResolvedValueOnce(lease); // holder released: takeover
    const timers = makeTimerHarness();
    const log = { info: vi.fn(), warn: vi.fn() };

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        random: () => 0,
        logger: log,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });

    // First attempt is contended: no throw, a standby retry is scheduled.
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getLease()).toBeUndefined();
    expect(timers.pendingCount()).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 0 }),
      expect.stringContaining('stands by to coordinate recovery'),
    );

    // Holder drains and releases; the next standby attempt takes over.
    timers.fireNext();
    await expect(manager.whenAcquired()).resolves.toBe(lease);
    expect(manager.getLease()).toBe(lease);
    expect(tryAcquire).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels a pending standby retry so tests exit cleanly', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const tryAcquire = vi.fn(async () => undefined);
    const timers = makeTimerHarness();

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        random: () => 0,
        logger: silentLogger,
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pendingCount()).toBe(1);

    await manager.stop();
    expect(timers.pendingCount()).toBe(0);
    await expect(manager.whenAcquired()).resolves.toBeUndefined();
  });

  it('stop() releases the lease once held (drain handoff)', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const lease = { release: vi.fn(async () => undefined) };
    const tryAcquire = vi.fn(async () => lease);

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: { logger: silentLogger },
    });

    await manager.whenAcquired();
    await manager.stop();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(manager.getLease()).toBeUndefined();
  });

  it('replays onAcquired when the lease was already held before onTransition registration', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const lease = { release: vi.fn(async () => undefined) };
    const tryAcquire = vi.fn(async () => lease);

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: { logger: silentLogger },
    });
    await manager.whenAcquired();

    const onAcquired = vi.fn();
    const onLost = vi.fn();
    manager.onTransition({ onAcquired, onLost });

    expect(onAcquired).toHaveBeenCalledWith(lease);
    expect(onLost).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('two workers, one lease: only the holder hosts; drain handoff moves hosting to the standby', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    // Shared singleton lease: first acquirer wins until it releases.
    let held = false;
    const makeLease = () => ({
      release: vi.fn(async () => {
        held = false;
      }),
    });
    const tryAcquire = vi.fn(async () => {
      if (held) return undefined;
      held = true;
      return makeLease();
    });
    const timers = makeTimerHarness();
    const deps = {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      random: () => 0,
      logger: silentLogger,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    };

    const workerA = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps,
    });
    const aAcquired = vi.fn();
    workerA.onTransition({ onAcquired: aAcquired, onLost: vi.fn() });
    await workerA.whenAcquired();

    const workerB = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps,
    });
    const bAcquired = vi.fn();
    workerB.onTransition({ onAcquired: bAcquired, onLost: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one host: A holds, B stands by on a retry timer.
    expect(aAcquired).toHaveBeenCalledOnce();
    expect(bAcquired).not.toHaveBeenCalled();
    expect(workerB.getLease()).toBeUndefined();
    expect(timers.pendingCount()).toBe(1);

    // A drains: lease released early, B's next standby attempt takes over.
    await workerA.stop();
    timers.fireNext();
    await expect(workerB.whenAcquired()).resolves.toBeDefined();
    expect(bAcquired).toHaveBeenCalledOnce();
    expect(workerB.getLease()).toBeDefined();

    await workerB.stop();
  });

  it('on lease loss: fires onLost, re-enters standby, and re-acquires once free', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const lostHandlers: Array<(err: Error) => void> = [];
    const firstLease = {
      onLost: (handler: (err: Error) => void) => {
        lostHandlers.push(handler);
      },
      release: vi.fn(async () => undefined),
    };
    const secondLease = { release: vi.fn(async () => undefined) };
    const tryAcquire = vi
      .fn<[], Promise<typeof firstLease | typeof secondLease | undefined>>()
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(undefined) // immediate retry after loss: still contended
      .mockResolvedValueOnce(secondLease);
    const timers = makeTimerHarness();
    const log = { info: vi.fn(), warn: vi.fn() };

    const manager = startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        random: () => 0,
        logger: log,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });
    const onAcquired = vi.fn();
    const onLost = vi.fn();
    manager.onTransition({ onAcquired, onLost });
    await manager.whenAcquired();
    expect(onAcquired).toHaveBeenCalledTimes(1);

    // The advisory-lock connection dies: consumer is notified, manager
    // re-enters standby acquisition in-process (no crash, no exit).
    lostHandlers.forEach((handler) =>
      handler(new Error('lease connection ended')),
    );
    expect(onLost).toHaveBeenCalledOnce();
    expect(manager.getLease()).toBeUndefined();

    // First retry is contended, then the lease frees up and we host again.
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pendingCount()).toBe(1);
    timers.fireNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(onAcquired).toHaveBeenCalledTimes(2);
    expect(manager.getLease()).toBe(secondLease);

    await manager.stop();
  });

  it('resolves live-turn scope from the exact thread route', async () => {
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentSessionId: 'session-thread',
    }));

    await expect(
      liveTurnScopeForQueue({
        app: {
          getConversationRoutes: () => ({
            [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: {
              folder: 'alpha',
              conversationKind: 'channel',
            },
            [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: {
              folder: 'alpha',
              conversationKind: 'dm',
            },
          }),
        },
        opsRepository: { getAgentTurnContext },
        executionAdapter: { id: 'anthropic:claude-agent-sdk' },
        queueJid: makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1'),
      }),
    ).resolves.toEqual({
      appId: 'default',
      agentSessionId: 'session-thread',
      conversationId: 'sl:C123',
      threadId: 'T1',
    });
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKind: 'dm' }),
    );
  });

  it('scopes recovered live-turn lookup to the provider account', async () => {
    const queueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      null,
      'slack-workspace-2',
    );
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentSessionId: 'session-workspace-2',
    }));

    await expect(
      liveTurnScopeForQueue({
        app: {
          getConversationRoutes: () => ({
            [queueJid]: {
              folder: 'alpha',
              conversationKind: 'channel',
            },
          }),
        },
        opsRepository: { getAgentTurnContext },
        executionAdapter: { id: 'anthropic:claude-agent-sdk' },
        queueJid,
      }),
    ).resolves.toEqual({
      appId: 'default',
      agentSessionId: 'session-workspace-2',
      conversationId: 'sl:C123',
      threadId: null,
    });
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'slack-workspace-2' }),
    );
  });

  it('does not resolve a thread route for a top-level live-turn queue', async () => {
    const getAgentTurnContext = vi.fn();

    await expect(
      liveTurnScopeForQueue({
        app: {
          getConversationRoutes: () => ({
            [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: {
              folder: 'alpha',
              conversationKind: 'channel',
            },
          }),
        },
        opsRepository: { getAgentTurnContext },
        executionAdapter: { id: 'anthropic:claude-agent-sdk' },
        queueJid: makeAgentThreadQueueKey('sl:C123', 'agent:alpha'),
      }),
    ).resolves.toBeNull();
    expect(getAgentTurnContext).not.toHaveBeenCalled();
  });

  it('routes scope-active pending messages to the owning live turn', async () => {
    const completeSessionAgentRun = vi.fn(async () => undefined);
    const onRouted = vi.fn(async () => undefined);
    const routeMessage = vi.fn(async () => 'queued_to_owner' as const);

    await expect(
      routeScopeActiveLiveTurnAdmission({
        scope: {
          appId: 'app:test',
          agentSessionId: 'session-1',
          conversationId: 'chat-1',
          threadId: null,
        },
        queueJid: 'chat-1',
        liveRunId: 'run-redundant',
        continuation: {
          text: 'Ravi: continue',
          senderUserIds: ['user-1'],
          idempotencyKey: 'continuation:chat-1:msg-1',
          onRouted,
        },
        routeMessage,
        completeSessionAgentRun,
      }),
    ).resolves.toBe(true);

    expect(routeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        queueJid: 'chat-1',
        text: 'Ravi: continue',
        senderUserIds: ['user-1'],
        idempotencyKey: 'continuation:chat-1:msg-1',
      }),
    );
    expect(onRouted).toHaveBeenCalledOnce();
    expect(completeSessionAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-redundant',
        status: 'canceled',
      }),
    );
  });

  it('requeues scope-active pending messages when replay fills the page', async () => {
    const enqueueMessageCheck = vi.fn();
    const routeMessage = vi.fn(async () => 'queued_to_owner' as const);
    const setAgentCursor = vi.fn();
    const saveState = vi.fn();
    const getMessagesSince = vi.fn(async () => [
      {
        id: 1,
        chat_jid: 'chat-1',
        sender: 'user-1',
        content: 'first',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
        message_id: 'msg-1',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'Ravi',
      },
    ]);

    await expect(
      routeScopeActiveLiveTurnAdmissionFromCursor({
        scope: {
          appId: 'app:test',
          agentSessionId: 'session-1',
          conversationId: 'chat-1',
          threadId: null,
        },
        queueJid: makeAgentThreadQueueKey(
          'chat-1',
          'agent:alpha',
          undefined,
          'slack_beta',
        ),
        liveRunId: 'run-active',
        chatJid: 'chat-1',
        threadId: null,
        replayCursor: '2024-01-01T00:00:00.000Z::0',
        messageFetchPageSize: 1,
        timezone: 'UTC',
        getMessagesSince,
        setAgentCursor,
        saveState,
        enqueueMessageCheck,
        routeMessage,
      }),
    ).resolves.toBe(true);

    expect(routeMessage).toHaveBeenCalledOnce();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      makeAgentThreadQueueKey('chat-1', 'agent:alpha', undefined, 'slack_beta'),
    );
    expect(getMessagesSince).toHaveBeenCalledWith(
      'chat-1',
      '2024-01-01T00:00:00.000Z::0',
      1,
      { threadId: null, providerAccountId: 'slack_beta' },
    );
  });

  it('routes only earlier replay messages before an active /compact', async () => {
    const routeMessage = vi.fn(async () => 'queued_to_owner' as const);
    const isActiveControlMessage = vi.fn(
      (message) => message.content === '/compact',
    );
    const handleActiveControlMessage = vi.fn(async () => false);
    const setAgentCursor = vi.fn();
    const saveState = vi.fn();
    const enqueueMessageCheck = vi.fn();
    const messages = [
      {
        id: 1,
        chat_jid: 'chat-1',
        sender: 'user-1',
        content: 'normal first',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
        message_id: 'msg-1',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'Ravi',
      },
      {
        id: 2,
        chat_jid: 'chat-1',
        sender: 'user-1',
        content: '/compact',
        timestamp: '2024-01-01T00:00:02.000Z',
        is_from_me: true,
        message_id: 'msg-2',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'Ravi',
      },
    ];

    await expect(
      routeScopeActiveLiveTurnAdmissionFromCursor({
        scope: {
          appId: 'app:test',
          agentSessionId: 'session-1',
          conversationId: 'chat-1',
          threadId: null,
        },
        queueJid: 'chat-1',
        liveRunId: 'run-active',
        chatJid: 'chat-1',
        threadId: null,
        replayCursor: '2024-01-01T00:00:00.000Z::0',
        messageFetchPageSize: 10,
        timezone: 'UTC',
        getMessagesSince: vi.fn(async () => messages),
        setAgentCursor,
        saveState,
        enqueueMessageCheck,
        isActiveControlMessage,
        handleActiveControlMessage,
        routeMessage,
      }),
    ).resolves.toBe(true);

    expect(handleActiveControlMessage).toHaveBeenCalledOnce();
    expect(handleActiveControlMessage).toHaveBeenCalledWith(messages[0]);
    expect(isActiveControlMessage).toHaveBeenCalledWith(messages[1]);
    expect(routeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('normal first'),
      }),
    );
    expect(routeMessage.mock.calls[0][0].text).not.toContain('/compact');
    expect(setAgentCursor).toHaveBeenCalledWith(
      'chat-1',
      JSON.stringify({ timestamp: '2024-01-01T00:00:01.000Z', id: 1 }),
    );
    expect(enqueueMessageCheck).toHaveBeenCalledWith('chat-1');
  });
});

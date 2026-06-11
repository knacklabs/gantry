import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_TURN_HOST_LEASE_KEY,
  routeScopeActiveLiveTurnAdmission,
  startLiveTurnHostLeaseAcquisition,
} from '@core/app/bootstrap/live-turn-host.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

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

    const manager = startLiveTurnHostLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
    });

    await expect(manager.whenAcquired()).resolves.toBeUndefined();
    expect(manager.getLease()).toBeUndefined();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('acquires the single live-turn host lease by default', async () => {
    const runtimeSettings = createDefaultRuntimeSettings();
    const lease = { release: vi.fn() };
    const tryAcquire = vi.fn(async () => lease);

    const manager = startLiveTurnHostLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: { logger: silentLogger },
    });

    await expect(manager.whenAcquired()).resolves.toBe(lease);
    expect(manager.getLease()).toBe(lease);
    expect(tryAcquire).toHaveBeenCalledWith(LIVE_TURN_HOST_LEASE_KEY);
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

    const manager = startLiveTurnHostLeaseAcquisition({
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
      expect.stringContaining('standing by'),
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

    const manager = startLiveTurnHostLeaseAcquisition({
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

    const manager = startLiveTurnHostLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire },
      deps: { logger: silentLogger },
    });

    await manager.whenAcquired();
    await manager.stop();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(manager.getLease()).toBeUndefined();
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
});

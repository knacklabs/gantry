import { describe, expect, it } from 'vitest';

import {
  claimLiveTurnExecution,
  finalizeLiveTurnExecution,
  heartbeatLiveTurnLease,
  liveTurnSlotHolderId,
  recoverLiveTurnExecution,
  liveTurnSlotKey,
  type LiveTurnLeaseDeps,
} from '@core/application/live-turns/live-turn-lease-service.js';
import type {
  LiveTurnCoordinationRepository,
  LiveTurnScope,
} from '@core/domain/ports/live-turns.js';

import { FakeCoordination, FakeLiveTurns } from './live-turn-lease-fakes.js';

function makeScope(patch: Partial<LiveTurnScope> = {}): LiveTurnScope {
  return {
    appId: 'default',
    agentSessionId: 'session-1',
    conversationId: 'tg:lease-service',
    threadId: null,
    ...patch,
  };
}

function makeDeps(): {
  deps: LiveTurnLeaseDeps;
  liveTurns: FakeLiveTurns;
  coordination: FakeCoordination;
} {
  const liveTurns = new FakeLiveTurns();
  const coordination = new FakeCoordination();
  liveTurns.coordination = coordination;
  return {
    deps: {
      liveTurns: liveTurns as unknown as LiveTurnCoordinationRepository,
      coordination,
      workerInstanceId: 'w1',
    },
    liveTurns,
    coordination,
  };
}

describe('claimLiveTurnExecution', () => {
  it('claims slot, scope, and lease, then projects the lease onto the turn', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const result = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
      pendingMessage: { text: 'hi' },
    });
    expect(result.outcome).toBe('claimed');
    if (result.outcome !== 'claimed') return;
    expect(result.lease.fencingVersion).toBe(1);
    expect(result.turn.runId).toBe('run-1');
    const stored = liveTurns.turns.get('turn-1');
    expect(stored).toMatchObject({
      state: 'claimed',
      leaseToken: result.lease.leaseToken,
      fencingVersion: 1,
      workerInstanceId: 'w1',
    });
    // Slot is held under the lease generation; the provisional hold is gone.
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([
      liveTurnSlotHolderId('turn-1', 1),
    ]);
  });

  it('routes to the active turn instead of claiming a duplicate', async () => {
    const { deps, coordination } = makeDeps();
    const first = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    expect(first.outcome).toBe('claimed');
    const second = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-2',
      scope: makeScope(),
      runId: 'run-2',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    expect(second).toMatchObject({
      outcome: 'scope_active',
      activeTurn: { id: 'turn-1' },
    });
    // The losing admission left no slot hold behind.
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([
      liveTurnSlotHolderId('turn-1', 1),
    ]);
  });

  it('defers on capacity without leaving a turn behind', async () => {
    const { deps, liveTurns } = makeDeps();
    const first = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope({ conversationId: 'tg:a' }),
      runId: 'run-1',
      slotCapacity: 1,
      leaseTtlMs: 60_000,
    });
    expect(first.outcome).toBe('claimed');
    const second = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-2',
      scope: makeScope({ conversationId: 'tg:b' }),
      runId: 'run-2',
      slotCapacity: 1,
      leaseTtlMs: 60_000,
    });
    expect(second.outcome).toBe('no_capacity');
    expect(liveTurns.turns.has('turn-2')).toBe(false);
  });

  it('unwinds slot and turn when the lease cannot be claimed', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    // Pre-claim the run's lease so the turn claim succeeds but the lease
    // claim fails.
    await coordination.claimRunLease({
      runId: 'run-1',
      workerInstanceId: 'other-worker',
      ttlMs: 60_000,
    });
    const result = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    expect(result.outcome).toBe('lease_unavailable');
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('failed');
  });

  it('unwinds the lease, provisional slot, and turn when slot re-home fails', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const acquireRunSlot = coordination.acquireRunSlot.bind(coordination);
    let acquireCalls = 0;
    coordination.acquireRunSlot = async (input) => {
      acquireCalls += 1;
      if (acquireCalls === 2) return false;
      return acquireRunSlot(input);
    };

    const result = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });

    expect(result.outcome).toBe('no_capacity');
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
    expect(coordination.leases).toMatchObject([
      {
        runId: 'run-1',
        status: 'released',
      },
    ]);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('failed');
  });

  it('unwinds the lease, live slot, and turn when lease attachment fails', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    liveTurns.attachLiveTurnLease = async () => false;

    const result = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });

    expect(result.outcome).toBe('lease_unavailable');
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
    expect(coordination.leases).toMatchObject([
      {
        runId: 'run-1',
        status: 'released',
      },
    ]);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('failed');
  });
});

describe('heartbeatLiveTurnLease', () => {
  it('renews lease and slot while the lease is alive', async () => {
    const { deps, coordination } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('claim failed');
    await expect(
      heartbeatLiveTurnLease({
        deps,
        turnId: 'turn-1',
        lease: claim.lease,
        leaseTtlMs: 60_000,
      }),
    ).resolves.toEqual({ leaseAlive: true, slotHeld: true });

    coordination.expireLease(claim.lease.leaseToken);
    await expect(
      heartbeatLiveTurnLease({
        deps,
        turnId: 'turn-1',
        lease: claim.lease,
        leaseTtlMs: 60_000,
      }),
    ).resolves.toEqual({ leaseAlive: false, slotHeld: false });
  });
});

describe('finalizeLiveTurnExecution', () => {
  it('settles the lease and turn together and frees the slot', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('claim failed');
    await expect(
      finalizeLiveTurnExecution({
        deps,
        turnId: 'turn-1',
        fence: {
          leaseToken: claim.lease.leaseToken,
          workerInstanceId: claim.lease.workerInstanceId,
          fencingVersion: claim.lease.fencingVersion,
        },
        turnState: 'completed',
        leaseOutcome: 'completed',
        agentRunCompletion: {
          status: 'completed',
          resultSummary: 'Live turn completed.',
        },
      }),
    ).resolves.toBe(true);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('completed');
    expect(liveTurns.agentRunCompletions).toEqual([
      {
        runId: 'run-1',
        status: 'completed',
        resultSummary: 'Live turn completed.',
      },
    ]);
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
    // The scope is claimable again.
    const next = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-2',
      scope: makeScope(),
      runId: 'run-2',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    expect(next.outcome).toBe('claimed');
  });

  it('drops stale-owner terminal writes but releases the stale slot hold', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 3,
      leaseTtlMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('claim failed');

    // The owner crashes; a recoverer takes the turn at a higher fence.
    coordination.expireLease(claim.lease.leaseToken);
    const recovery = await recoverLiveTurnExecution({
      deps: { ...deps, workerInstanceId: 'w2' },
      turn: liveTurns.turns.get('turn-1')!,
      slotCapacity: 3,
      leaseTtlMs: 60_000,
    });
    expect(recovery.outcome).toBe('recovered');

    // Stale owner's terminal write is fenced out.
    await expect(
      finalizeLiveTurnExecution({
        deps,
        turnId: 'turn-1',
        fence: {
          leaseToken: claim.lease.leaseToken,
          workerInstanceId: claim.lease.workerInstanceId,
          fencingVersion: claim.lease.fencingVersion,
        },
        turnState: 'failed',
        leaseOutcome: 'failed',
      }),
    ).resolves.toBe(false);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('recovered');
    expect(liveTurns.agentRunCompletions).toEqual([]);
    // Per-worker slot keys (WP2): the original owner's slot (w1) is freed when
    // its stale finalize releases, and the recoverer holds its own generation
    // under the RECOVERING worker's key (w2).
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
    expect(coordination.slotHolders(liveTurnSlotKey('w2'))).toEqual([
      liveTurnSlotHolderId('turn-1', 2),
    ]);
  });

  it('releases the live slot when fenced finalization throws', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('claim failed');
    liveTurns.finalizeLiveTurnWithLease = async () => {
      throw new Error('db unavailable');
    };

    await expect(
      finalizeLiveTurnExecution({
        deps,
        turnId: 'turn-1',
        fence: {
          leaseToken: claim.lease.leaseToken,
          workerInstanceId: claim.lease.workerInstanceId,
          fencingVersion: claim.lease.fencingVersion,
        },
        turnState: 'failed',
        leaseOutcome: 'failed',
      }),
    ).rejects.toThrow('db unavailable');
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
  });
});

describe('recoverLiveTurnExecution', () => {
  it('refuses recovery while the owner lease is still live', async () => {
    const { deps, liveTurns } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    expect(claim.outcome).toBe('claimed');
    const recovery = await recoverLiveTurnExecution({
      deps: { ...deps, workerInstanceId: 'w2' },
      turn: liveTurns.turns.get('turn-1')!,
      slotCapacity: 2,
      leaseTtlMs: 60_000,
    });
    expect(recovery.outcome).toBe('lease_unavailable');
  });

  it('recovers with a strictly higher fencing version and marks the turn recovered', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 3,
      leaseTtlMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('claim failed');
    coordination.expireLease(claim.lease.leaseToken);

    const recovery = await recoverLiveTurnExecution({
      deps: { ...deps, workerInstanceId: 'w2' },
      turn: liveTurns.turns.get('turn-1')!,
      slotCapacity: 3,
      leaseTtlMs: 60_000,
    });
    expect(recovery.outcome).toBe('recovered');
    if (recovery.outcome !== 'recovered') return;
    expect(recovery.lease.fencingVersion).toBeGreaterThan(
      claim.lease.fencingVersion,
    );
    expect(liveTurns.turns.get('turn-1')).toMatchObject({
      state: 'recovered',
      workerInstanceId: 'w2',
      fencingVersion: recovery.lease.fencingVersion,
      retryCount: 1,
    });
  });

  it('releases the recovery lease when the turn settled first', async () => {
    const { deps, liveTurns, coordination } = makeDeps();
    const claim = await claimLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      scope: makeScope(),
      runId: 'run-1',
      slotCapacity: 3,
      leaseTtlMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('claim failed');
    const snapshot = { ...liveTurns.turns.get('turn-1')! };
    await finalizeLiveTurnExecution({
      deps,
      turnId: 'turn-1',
      fence: {
        leaseToken: claim.lease.leaseToken,
        workerInstanceId: claim.lease.workerInstanceId,
        fencingVersion: claim.lease.fencingVersion,
      },
      turnState: 'completed',
      leaseOutcome: 'completed',
    });

    const recovery = await recoverLiveTurnExecution({
      deps: { ...deps, workerInstanceId: 'w2' },
      turn: snapshot,
      slotCapacity: 3,
      leaseTtlMs: 60_000,
    });
    expect(recovery.outcome).toBe('turn_gone');
    // The recovery lease and slot were both released.
    expect(
      coordination.leases.filter((row) => row.status === 'active'),
    ).toEqual([]);
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
  });
});

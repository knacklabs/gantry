import { describe, expect, it } from 'vitest';

import { runLiveTurnRecoveryTick } from '@core/runtime/live-turn-recovery.js';
import {
  claimLiveTurnExecution,
  liveTurnSlotKey,
} from '@core/application/live-turns/live-turn-lease-service.js';
import type {
  LiveTurn,
  LiveTurnCoordinationRepository,
  LiveTurnScope,
} from '@core/domain/ports/live-turns.js';
import type { RunLease } from '@core/domain/ports/worker-coordination.js';

import {
  FakeCoordination,
  FakeLiveTurns,
} from '../application/live-turn-lease-fakes.js';

function makeScope(conversationId: string): LiveTurnScope {
  return {
    appId: 'default',
    agentSessionId: 'session-1',
    conversationId,
    threadId: null,
  };
}

function makeDeps(workerInstanceId = 'w2') {
  const liveTurns = new FakeLiveTurns();
  const coordination = new FakeCoordination();
  liveTurns.coordination = coordination;
  return {
    deps: {
      liveTurns: liveTurns as unknown as LiveTurnCoordinationRepository,
      coordination,
      workerInstanceId,
    },
    liveTurns,
    coordination,
  };
}

async function claimCrashedTurn(args: {
  deps: ReturnType<typeof makeDeps>;
  turnId: string;
  runId: string;
  conversationId: string;
}): Promise<void> {
  const claim = await claimLiveTurnExecution({
    deps: { ...args.deps.deps, workerInstanceId: 'w1' },
    turnId: args.turnId,
    scope: makeScope(args.conversationId),
    runId: args.runId,
    slotCapacity: 10,
    leaseTtlMs: 60_000,
  });
  if (claim.outcome !== 'claimed') throw new Error('setup claim failed');
  // The owner crashes: its lease expires and the turn becomes recoverable.
  args.deps.coordination.expireLease(claim.lease.leaseToken);
  args.deps.liveTurns.recoverableIds.add(args.turnId);
}

describe('runLiveTurnRecoveryTick', () => {
  it('recovers expired turns and resumes them under the new lease', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:recover-1',
    });
    const resumed: Array<{ turn: LiveTurn; lease: RunLease }> = [];
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async (args) => {
        resumed.push(args);
      },
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result).toEqual({
      recovered: 1,
      timedOut: 0,
      capacityExhausted: false,
      ineligible: 0,
      noEligibleRecoverer: 0,
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.lease.fencingVersion).toBe(2);
    expect(ctx.liveTurns.turns.get('turn-1')).toMatchObject({
      state: 'recovered',
      workerInstanceId: 'w2',
      fencingVersion: 2,
    });
  });

  it('settles a recovered turn as failed when resume throws', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:recover-fail',
    });
    const warnings: string[] = [];
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => {
        throw new Error('runner spawn failed');
      },
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
      warn: (_context, message) => warnings.push(message),
    });
    expect(result.recovered).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(ctx.liveTurns.turns.get('turn-1')?.state).toBe('failed');
    expect(ctx.liveTurns.agentRunCompletions).toEqual([
      {
        runId: 'run-1',
        status: 'failed',
        errorSummary: 'Recovered live turn failed to resume.',
      },
    ]);
    // No active lease is left behind for the failed resume.
    expect(
      ctx.coordination.leases.filter((row) => row.status === 'active'),
    ).toEqual([]);
  });

  it('times out unleased stale claims without recovery', async () => {
    const ctx = makeDeps();
    await ctx.liveTurns.claimLiveTurn({
      id: 'turn-unleased',
      scope: makeScope('tg:unleased'),
      workerInstanceId: 'w1',
    });
    ctx.liveTurns.recoverableIds.add('turn-unleased');
    const timedOut: string[] = [];
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => {
        throw new Error('should not resume');
      },
      onTurnTimedOut: (turn) => {
        timedOut.push(turn.id);
      },
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result).toEqual({
      recovered: 0,
      timedOut: 1,
      capacityExhausted: false,
      ineligible: 0,
      noEligibleRecoverer: 0,
    });
    expect(timedOut).toEqual(['turn-unleased']);
    expect(ctx.liveTurns.turns.get('turn-unleased')?.state).toBe('timed_out');
  });

  it('times out stale admissions that have a run id but no lease projection', async () => {
    const ctx = makeDeps();
    await ctx.liveTurns.claimLiveTurn({
      id: 'turn-unleased-run',
      scope: makeScope('tg:unleased-run'),
      workerInstanceId: 'w1',
      runId: 'run-unleased',
    });
    ctx.liveTurns.recoverableIds.add('turn-unleased-run');
    const timedOut: string[] = [];
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => {
        throw new Error('should not resume');
      },
      onTurnTimedOut: (turn) => {
        timedOut.push(turn.id);
      },
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });

    expect(result).toEqual({
      recovered: 0,
      timedOut: 1,
      capacityExhausted: false,
      ineligible: 0,
      noEligibleRecoverer: 0,
    });
    expect(timedOut).toEqual(['turn-unleased-run']);
    expect(ctx.liveTurns.turns.get('turn-unleased-run')?.state).toBe(
      'timed_out',
    );
    expect(ctx.liveTurns.agentRunCompletions).toEqual([
      {
        runId: 'run-unleased',
        status: 'failed',
        errorSummary: 'Live turn timed out before a worker lease was attached.',
      },
    ]);
  });

  it('skips turns another worker already recovered', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:already-recovered',
    });
    // Another worker wins the lease before this tick runs.
    const otherLease = await ctx.coordination.claimRunLease({
      runId: 'run-1',
      workerInstanceId: 'w3',
      ttlMs: 60_000,
    });
    expect(otherLease).not.toBeNull();
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => {
        throw new Error('should not resume');
      },
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result.recovered).toBe(0);
  });

  it('stops early when local capacity is exhausted', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:capacity-1',
    });
    // Per-worker slot keys (WP2): capacity bounds the RECOVERING worker (w2),
    // not the cluster. The crashed owner's stale holds live under w1's key and
    // never consume w2's capacity. Saturate w2's own key so the recovery
    // generation cannot acquire a slot and the sweep defers.
    ctx.coordination.slots.set(
      liveTurnSlotKey('w2'),
      new Set(['existing-turn:1']),
    );
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => undefined,
      slotCapacity: 1,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result.capacityExhausted).toBe(true);
    expect(result.recovered).toBe(0);
  });

  it('does not recover a turn this worker is ineligible for', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:ineligible',
    });
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => {
        throw new Error('should not resume an ineligible turn');
      },
      isEligible: () => false,
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result.recovered).toBe(0);
    expect(result.ineligible).toBe(1);
    // The lease is untouched so an eligible worker can still recover it.
    expect(
      ctx.coordination.leases.filter((row) => row.status === 'active'),
    ).toEqual([]);
  });

  it('fires the no-eligible-recoverer alert when no worker can recover', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:no-recoverer',
    });
    const stranded: string[] = [];
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => undefined,
      isEligible: () => false,
      onNoEligibleRecoverer: async (turn) => {
        stranded.push(turn.id);
      },
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result.ineligible).toBe(1);
    expect(result.noEligibleRecoverer).toBe(1);
    expect(stranded).toEqual(['turn-1']);
  });

  it('recovers when this worker is eligible for the turn', async () => {
    const ctx = makeDeps();
    await claimCrashedTurn({
      deps: ctx,
      turnId: 'turn-1',
      runId: 'run-1',
      conversationId: 'tg:eligible',
    });
    const result = await runLiveTurnRecoveryTick({
      deps: ctx.deps,
      resumeRecoveredTurn: async () => undefined,
      isEligible: () => true,
      slotCapacity: 10,
      leaseTtlMs: 60_000,
      unleasedStaleMs: 300_000,
    });
    expect(result.recovered).toBe(1);
    expect(result.ineligible).toBe(0);
  });
});

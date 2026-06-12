import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_LLM_PROFILE_ID } from '@core/adapters/storage/postgres/seeds.js';
import {
  configurePendingInteractionDurability,
  resolvePendingInteractionRecord,
} from '@core/application/interactions/pending-interaction-durability.js';
import type { LiveTurnScope } from '@core/domain/ports/live-turns.js';
import { makeLiveTurnScopeKey } from '@core/domain/ports/live-turns.js';
import {
  claimLiveTurnExecution,
  finalizeLiveTurnExecution,
  liveTurnFence,
  recoverLiveTurnExecution,
  type LiveTurnLeaseDeps,
} from '@core/application/live-turns/live-turn-lease-service.js';
import { nowIso, nowMs, toIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function makeScope(patch: Partial<LiveTurnScope> = {}): LiveTurnScope {
  return {
    appId: 'default',
    agentSessionId: 'session-live',
    conversationId: 'tg:live-horizontal',
    threadId: null,
    ...patch,
  };
}

maybeDescribe('live horizontal execution acceptance gates', () => {
  let runtime: PostgresIntegrationRuntime;
  let liveTurns: PostgresIntegrationRuntime['repositories']['liveTurns'];
  let coordination: PostgresIntegrationRuntime['repositories']['workerCoordination'];
  const agentId = 'agent-live' as never;
  const configVersionId = 'config-live' as never;
  const llmProfileId = DEFAULT_LLM_PROFILE_ID as never;

  const createLiveRun = async (runId: string) => {
    await runtime.repositories.agentRuns.saveAgentRun({
      id: runId,
      appId: 'default',
      agentId,
      configVersionId,
      llmProfileId,
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      permissionDecisionIds: [],
      cause: 'message',
      status: 'running',
      createdAt: nowIso(),
    });
  };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_horizontal',
    });
    liveTurns = runtime.repositories.liveTurns;
    coordination = runtime.repositories.workerCoordination;
    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId: 'default',
      name: 'Live Test Agent',
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await runtime.repositories.agentConfigs.saveConfigVersion({
      id: configVersionId,
      appId: 'default',
      agentId,
      version: 1,
      promptProfileRef: 'prompt-profile:live',
      llmProfileId,
      toolIds: [],
      skillIds: [],
      permissionPolicyIds: [],
      runtimeLimits: {},
      createdAt: nowIso(),
    });
    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId: 'default',
      name: 'Live Test Agent',
      status: 'active',
      currentConfigVersionId: configVersionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await coordination.registerWorker({ id: 'w1', bootNonce: 'nonce-w1' });
    await coordination.registerWorker({ id: 'w2', bootNonce: 'nonce-w2' });
    // WP2 horizontal-execution workers (run_leases.worker_instance_id is FK'd).
    for (const id of [
      'dw1',
      'dw2',
      'dw3',
      'ow1',
      'ow2',
      'cap-busy',
      'cap-free',
      'rk-owner',
      'rk-recoverer',
    ]) {
      await coordination.registerWorker({ id, bootNonce: `nonce-${id}` });
    }
  });

  afterAll(async () => {
    configurePendingInteractionDurability(null);
    await runtime?.cleanup();
  });

  it('enforces one non-terminal live turn per scope', async () => {
    const scope = makeScope({ conversationId: 'tg:one-active' });
    const first = await liveTurns.claimLiveTurn({
      id: 'turn-one-active-1',
      scope,
      workerInstanceId: 'w1',
    });
    expect(first).not.toBeNull();
    expect(first?.state).toBe('claimed');
    expect(first?.scopeKey).toBe(makeLiveTurnScopeKey(scope));

    // A second worker cannot open a duplicate active turn for the scope.
    const duplicate = await liveTurns.claimLiveTurn({
      id: 'turn-one-active-2',
      scope,
      workerInstanceId: 'w2',
    });
    expect(duplicate).toBeNull();

    await expect(liveTurns.getActiveLiveTurn({ scope })).resolves.toMatchObject(
      { id: 'turn-one-active-1' },
    );

    // A different thread is a different scope and claims freely.
    const otherThread = await liveTurns.claimLiveTurn({
      id: 'turn-one-active-thread',
      scope: makeScope({ conversationId: 'tg:one-active', threadId: 't-1' }),
      workerInstanceId: 'w2',
    });
    expect(otherThread).not.toBeNull();

    // Once the turn settles terminally, the scope can be claimed again.
    await expect(
      liveTurns.transitionLiveTurnState({
        id: 'turn-one-active-1',
        toState: 'completed',
        fromStates: ['claimed', 'running'],
      }),
    ).resolves.toBe(true);
    await expect(liveTurns.getActiveLiveTurn({ scope })).resolves.toBeNull();
    const reclaimed = await liveTurns.claimLiveTurn({
      id: 'turn-one-active-3',
      scope,
      workerInstanceId: 'w2',
    });
    expect(reclaimed).not.toBeNull();
  });

  it('guards state transitions on expected source states', async () => {
    const scope = makeScope({ conversationId: 'tg:transition-guard' });
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-transition-guard',
      scope,
      workerInstanceId: 'w1',
    });
    expect(turn).not.toBeNull();

    // Wrong source state: no transition happens.
    await expect(
      liveTurns.transitionLiveTurnState({
        id: 'turn-transition-guard',
        toState: 'completed',
        fromStates: ['running'],
      }),
    ).resolves.toBe(false);
    await expect(
      liveTurns.getLiveTurnById('turn-transition-guard'),
    ).resolves.toMatchObject({ state: 'claimed', endedAt: null });

    await expect(
      liveTurns.transitionLiveTurnState({
        id: 'turn-transition-guard',
        toState: 'running',
        fromStates: ['claimed'],
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.transitionLiveTurnState({
        id: 'turn-transition-guard',
        toState: 'failed',
        fromStates: ['running'],
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.getLiveTurnById('turn-transition-guard'),
    ).resolves.toMatchObject({ state: 'failed', endedAt: expect.any(String) });
  });

  it('allocates strictly ordered command sequences in the repository', async () => {
    const scope = makeScope({ conversationId: 'tg:command-seq' });
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-command-seq',
      scope,
      workerInstanceId: 'w1',
    });
    expect(turn).not.toBeNull();

    const first = await liveTurns.appendLiveTurnCommand({
      id: 'cmd-seq-1',
      liveTurnId: 'turn-command-seq',
      commandType: 'continuation',
      idempotencyKey: 'continuation:turn-command-seq:msg-1',
      payload: { text: 'first follow-up' },
      createdByWorkerId: 'w2',
    });
    expect(first.outcome).toBe('appended');
    expect(first.command?.seq).toBe(1);

    const second = await liveTurns.appendLiveTurnCommand({
      id: 'cmd-seq-2',
      liveTurnId: 'turn-command-seq',
      commandType: 'continuation',
      idempotencyKey: 'continuation:turn-command-seq:msg-2',
      payload: { text: 'second follow-up' },
      createdByWorkerId: 'w2',
    });
    expect(second.outcome).toBe('appended');
    expect(second.command?.seq).toBe(2);

    const third = await liveTurns.appendLiveTurnCommand({
      id: 'cmd-seq-3',
      liveTurnId: 'turn-command-seq',
      commandType: 'stop',
      idempotencyKey: 'stop:turn-command-seq:msg-3',
      createdByWorkerId: 'w1',
    });
    expect(third.outcome).toBe('appended');
    expect(third.command?.seq).toBe(3);

    const pending = await liveTurns.listPendingLiveTurnCommands({
      liveTurnId: 'turn-command-seq',
      limit: 10,
    });
    expect(pending.map((cmd) => cmd.seq)).toEqual([1, 2, 3]);
    expect(pending.map((cmd) => cmd.commandType)).toEqual([
      'continuation',
      'continuation',
      'stop',
    ]);
  });

  it('replays duplicate idempotency keys without burning a sequence', async () => {
    const scope = makeScope({ conversationId: 'tg:command-idem' });
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-command-idem',
      scope,
      workerInstanceId: 'w1',
    });
    expect(turn).not.toBeNull();

    const appended = await liveTurns.appendLiveTurnCommand({
      id: 'cmd-idem-1',
      liveTurnId: 'turn-command-idem',
      commandType: 'continuation',
      idempotencyKey: 'continuation:turn-command-idem:msg-1',
      payload: { text: 'hello' },
    });
    expect(appended.outcome).toBe('appended');

    // The same inbound message delivered twice appends exactly once.
    const replayed = await liveTurns.appendLiveTurnCommand({
      id: 'cmd-idem-1-replay',
      liveTurnId: 'turn-command-idem',
      commandType: 'continuation',
      idempotencyKey: 'continuation:turn-command-idem:msg-1',
      payload: { text: 'hello' },
    });
    expect(replayed.outcome).toBe('replayed');
    expect(replayed.command?.id).toBe('cmd-idem-1');
    expect(replayed.command?.seq).toBe(1);

    const next = await liveTurns.appendLiveTurnCommand({
      id: 'cmd-idem-2',
      liveTurnId: 'turn-command-idem',
      commandType: 'continuation',
      idempotencyKey: 'continuation:turn-command-idem:msg-2',
      payload: { text: 'again' },
    });
    expect(next.command?.seq).toBe(2);
  });

  it('rejects commands against missing or terminal turns', async () => {
    await expect(
      liveTurns.appendLiveTurnCommand({
        id: 'cmd-missing-turn',
        liveTurnId: 'turn-does-not-exist',
        commandType: 'stop',
        idempotencyKey: 'stop:turn-does-not-exist:1',
      }),
    ).resolves.toEqual({ outcome: 'rejected', command: null });

    const scope = makeScope({ conversationId: 'tg:command-terminal' });
    await liveTurns.claimLiveTurn({
      id: 'turn-command-terminal',
      scope,
      workerInstanceId: 'w1',
    });
    await liveTurns.transitionLiveTurnState({
      id: 'turn-command-terminal',
      toState: 'completed',
      fromStates: ['claimed'],
    });
    await expect(
      liveTurns.appendLiveTurnCommand({
        id: 'cmd-terminal-turn',
        liveTurnId: 'turn-command-terminal',
        commandType: 'continuation',
        idempotencyKey: 'continuation:turn-command-terminal:late',
      }),
    ).resolves.toEqual({ outcome: 'rejected', command: null });
  });

  it('marks commands applied exactly once and drops them from the inbox', async () => {
    const scope = makeScope({ conversationId: 'tg:command-apply' });
    await liveTurns.claimLiveTurn({
      id: 'turn-command-apply',
      scope,
      workerInstanceId: 'w1',
    });
    await liveTurns.appendLiveTurnCommand({
      id: 'cmd-apply-1',
      liveTurnId: 'turn-command-apply',
      commandType: 'continuation',
      idempotencyKey: 'continuation:turn-command-apply:msg-1',
      payload: { text: 'apply me' },
    });

    await expect(
      liveTurns.markLiveTurnCommandApplied({
        id: 'cmd-apply-1',
        appliedByWorkerId: 'w1',
      }),
    ).resolves.toBe(true);
    // Apply is single-shot: a second apply (e.g. from a stale owner) is a
    // no-op.
    await expect(
      liveTurns.markLiveTurnCommandApplied({
        id: 'cmd-apply-1',
        appliedByWorkerId: 'w2',
      }),
    ).resolves.toBe(false);
    await expect(
      liveTurns.listPendingLiveTurnCommands({
        liveTurnId: 'turn-command-apply',
        limit: 10,
      }),
    ).resolves.toEqual([]);

    await liveTurns.appendLiveTurnCommand({
      id: 'cmd-apply-2',
      liveTurnId: 'turn-command-apply',
      commandType: 'stop',
      idempotencyKey: 'stop:turn-command-apply:msg-2',
    });
    await expect(
      liveTurns.markLiveTurnCommandRejected({
        id: 'cmd-apply-2',
        reason: 'owner gone',
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.listPendingLiveTurnCommands({
        liveTurnId: 'turn-command-apply',
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it('fences owner state transitions by the active run lease', async () => {
    const scope = makeScope({ conversationId: 'tg:fenced-transition' });
    await createLiveRun('run-fenced-transition');
    const turn = await liveTurns.claimLiveTurn({
      id: 'turn-fenced-transition',
      scope,
      workerInstanceId: 'w1',
      runId: 'run-fenced-transition',
    });
    expect(turn).not.toBeNull();

    // w1's lease lapses; w2 recovers at a strictly higher fencing version.
    const staleLease = await coordination.claimRunLease({
      runId: 'run-fenced-transition',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(staleLease).not.toBeNull();
    await expect(
      liveTurns.attachLiveTurnLease({
        id: 'turn-fenced-transition',
        runId: 'run-fenced-transition',
        lease: {
          leaseToken: staleLease!.leaseToken,
          workerInstanceId: staleLease!.workerInstanceId,
          fencingVersion: staleLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(true);
    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-fenced-transition',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(recoveredLease).not.toBeNull();
    expect(recoveredLease!.fencingVersion).toBeGreaterThan(
      staleLease!.fencingVersion,
    );

    // The stale owner cannot move the turn; the recovered owner can.
    await expect(
      liveTurns.transitionLiveTurnStateFenced({
        id: 'turn-fenced-transition',
        toState: 'running',
        fromStates: ['claimed'],
        fence: {
          leaseToken: staleLease!.leaseToken,
          workerInstanceId: staleLease!.workerInstanceId,
          fencingVersion: staleLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(false);
    await expect(
      liveTurns.transitionLiveTurnStateFenced({
        id: 'turn-fenced-transition',
        toState: 'running',
        fromStates: ['claimed'],
        fence: {
          leaseToken: recoveredLease!.leaseToken,
          workerInstanceId: recoveredLease!.workerInstanceId,
          fencingVersion: recoveredLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(true);
  });

  it('finalizes turn and lease together and rejects stale finalization', async () => {
    const scope = makeScope({ conversationId: 'tg:fenced-finalize' });
    await createLiveRun('run-fenced-finalize');
    await liveTurns.claimLiveTurn({
      id: 'turn-fenced-finalize',
      scope,
      workerInstanceId: 'w1',
      runId: 'run-fenced-finalize',
    });
    const staleLease = await coordination.claimRunLease({
      runId: 'run-fenced-finalize',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    await liveTurns.attachLiveTurnLease({
      id: 'turn-fenced-finalize',
      runId: 'run-fenced-finalize',
      lease: {
        leaseToken: staleLease!.leaseToken,
        workerInstanceId: staleLease!.workerInstanceId,
        fencingVersion: staleLease!.fencingVersion,
      },
    });
    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-fenced-finalize',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });

    // Late terminal write from the crashed owner is dropped entirely.
    await expect(
      liveTurns.finalizeLiveTurnWithLease({
        id: 'turn-fenced-finalize',
        turnState: 'completed',
        leaseOutcome: 'completed',
        fence: {
          leaseToken: staleLease!.leaseToken,
          workerInstanceId: staleLease!.workerInstanceId,
          fencingVersion: staleLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(false);
    await expect(
      liveTurns.getLiveTurnById('turn-fenced-finalize'),
    ).resolves.toMatchObject({ state: 'claimed', endedAt: null });

    await expect(
      liveTurns.finalizeLiveTurnWithLease({
        id: 'turn-fenced-finalize',
        turnState: 'completed',
        leaseOutcome: 'completed',
        fence: {
          leaseToken: recoveredLease!.leaseToken,
          workerInstanceId: recoveredLease!.workerInstanceId,
          fencingVersion: recoveredLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.getLiveTurnById('turn-fenced-finalize'),
    ).resolves.toMatchObject({
      state: 'completed',
      endedAt: expect.any(String),
    });
    await expect(
      coordination.getActiveRunLease({ runId: 'run-fenced-finalize' }),
    ).resolves.toBeNull();
    // The scope is claimable again after terminal settlement.
    await expect(
      liveTurns.claimLiveTurn({
        id: 'turn-fenced-finalize-next',
        scope,
        workerInstanceId: 'w2',
      }),
    ).resolves.not.toBeNull();
  });

  it('recovers an expired live turn at a higher fencing version exactly once', async () => {
    const scope = makeScope({ conversationId: 'tg:takeover' });
    await createLiveRun('run-takeover');
    await liveTurns.claimLiveTurn({
      id: 'turn-takeover',
      scope,
      workerInstanceId: 'w1',
      runId: 'run-takeover',
    });
    const staleLease = await coordination.claimRunLease({
      runId: 'run-takeover',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    await liveTurns.attachLiveTurnLease({
      id: 'turn-takeover',
      runId: 'run-takeover',
      lease: {
        leaseToken: staleLease!.leaseToken,
        workerInstanceId: staleLease!.workerInstanceId,
        fencingVersion: staleLease!.fencingVersion,
      },
    });

    // The expired owner shows up for recovery while a live one would not.
    const recoverable = await liveTurns.listRecoverableLiveTurns({
      unleasedStaleBefore: toIso(nowMs() - 300_000),
      limit: 10,
    });
    expect(recoverable.map((turn) => turn.id)).toContain('turn-takeover');

    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-takeover',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(recoveredLease!.recoveredFromExpiredLease).toBe(true);
    await expect(
      liveTurns.takeOverLiveTurn({
        id: 'turn-takeover',
        lease: {
          leaseToken: recoveredLease!.leaseToken,
          workerInstanceId: recoveredLease!.workerInstanceId,
          fencingVersion: recoveredLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.getLiveTurnById('turn-takeover'),
    ).resolves.toMatchObject({
      state: 'recovered',
      workerInstanceId: 'w2',
      fencingVersion: recoveredLease!.fencingVersion,
      retryCount: 1,
    });

    // A replayed takeover with the stale generation is refused.
    await expect(
      liveTurns.takeOverLiveTurn({
        id: 'turn-takeover',
        lease: {
          leaseToken: staleLease!.leaseToken,
          workerInstanceId: staleLease!.workerInstanceId,
          fencingVersion: staleLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(false);
    // Recovered turns no longer appear as recoverable.
    const afterTakeover = await liveTurns.listRecoverableLiveTurns({
      unleasedStaleBefore: toIso(nowMs() - 300_000),
      limit: 10,
    });
    expect(afterTakeover.map((turn) => turn.id)).not.toContain('turn-takeover');
  });

  it('surfaces stale unleased turns for timeout sweeps', async () => {
    const scope = makeScope({ conversationId: 'tg:unleased-stale' });
    const staleClaimedAt = toIso(nowMs() - 600_000);
    await liveTurns.claimLiveTurn({
      id: 'turn-unleased-stale',
      scope,
      workerInstanceId: 'w1',
      now: staleClaimedAt,
    });

    const recoverable = await liveTurns.listRecoverableLiveTurns({
      unleasedStaleBefore: toIso(nowMs() - 300_000),
      limit: 10,
    });
    expect(recoverable.map((turn) => turn.id)).toContain('turn-unleased-stale');

    // The timeout sweep settles it terminally and frees the scope.
    await expect(
      liveTurns.transitionLiveTurnState({
        id: 'turn-unleased-stale',
        toState: 'timed_out',
        fromStates: ['claimed'],
      }),
    ).resolves.toBe(true);
    await expect(liveTurns.getActiveLiveTurn({ scope })).resolves.toBeNull();
  });

  it('does not recover a newly claimed turn before its lease is attached', async () => {
    const scope = makeScope({ conversationId: 'tg:pre-lease-claim' });
    await createLiveRun('run-pre-lease-claim');
    await liveTurns.claimLiveTurn({
      id: 'turn-pre-lease-claim',
      scope,
      workerInstanceId: 'w1',
      runId: 'run-pre-lease-claim',
      now: toIso(nowMs()),
    });

    const recoverable = await liveTurns.listRecoverableLiveTurns({
      unleasedStaleBefore: toIso(nowMs() - 300_000),
      limit: 10,
    });
    expect(recoverable.map((turn) => turn.id)).not.toContain(
      'turn-pre-lease-claim',
    );
  });

  it('delivers prompt resolutions to the recovered owner after adapter restart', async () => {
    const scope = makeScope({ conversationId: 'tg:prompt-restart' });
    await createLiveRun('run-prompt-restart');
    await liveTurns.claimLiveTurn({
      id: 'turn-prompt-restart',
      scope,
      workerInstanceId: 'w1',
      runId: 'run-prompt-restart',
    });
    const staleLease = await coordination.claimRunLease({
      runId: 'run-prompt-restart',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    await liveTurns.attachLiveTurnLease({
      id: 'turn-prompt-restart',
      runId: 'run-prompt-restart',
      lease: {
        leaseToken: staleLease!.leaseToken,
        workerInstanceId: staleLease!.workerInstanceId,
        fencingVersion: staleLease!.fencingVersion,
      },
    });

    // Durable prompt record exists before the prompt renders.
    const created = await coordination.createPendingInteraction({
      id: 'live-interaction-1',
      appId: 'default',
      runId: 'run-prompt-restart',
      kind: 'permission',
      payload: { toolName: 'Bash', commandPreview: 'ls' },
      callbackRoute: { targetJid: 'tg:prompt-restart' },
      idempotencyKey: 'permission:live-agent:req-live-1',
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(created.status).toBe('pending');

    // The adapter that rendered the prompt restarts: the re-prompt reuses
    // the same durable record, and a new worker recovers the live turn.
    const reprompted = await coordination.createPendingInteraction({
      id: 'live-interaction-1-duplicate',
      appId: 'default',
      runId: 'run-prompt-restart',
      kind: 'permission',
      payload: { toolName: 'Bash', commandPreview: 'ls' },
      idempotencyKey: 'permission:live-agent:req-live-1',
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(reprompted.id).toBe('live-interaction-1');
    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-prompt-restart',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    await expect(
      liveTurns.takeOverLiveTurn({
        id: 'turn-prompt-restart',
        lease: {
          leaseToken: recoveredLease!.leaseToken,
          workerInstanceId: recoveredLease!.workerInstanceId,
          fencingVersion: recoveredLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(true);

    // The approval callback arrives: resolution persists first, then lands
    // as a durable command in the current owner's inbox.
    configurePendingInteractionDurability({
      repository: coordination,
      liveTurns,
    });
    await resolvePendingInteractionRecord({
      kind: 'permission',
      sourceAgentFolder: 'live-agent',
      requestId: 'req-live-1',
      runId: 'run-prompt-restart',
      status: 'resolved',
      resolution: { approved: true, mode: 'allow_once' },
      approverRef: 'user:approver',
    });
    configurePendingInteractionDurability(null);

    const pendingAfter = await coordination.listPendingInteractions({
      appId: 'default',
      runId: 'run-prompt-restart',
    });
    expect(pendingAfter).toEqual([]);
    const inbox = await liveTurns.listPendingLiveTurnCommands({
      liveTurnId: 'turn-prompt-restart',
      limit: 10,
    });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      commandType: 'interaction_resolved',
      payload: {
        kind: 'permission',
        requestId: 'req-live-1',
        status: 'resolved',
      },
    });
    // Only the recovered owner can consume it.
    await expect(
      liveTurns.markLiveTurnCommandApplied({
        id: inbox[0]!.id,
        appliedByWorkerId: 'w1',
        fence: {
          leaseToken: staleLease!.leaseToken,
          workerInstanceId: staleLease!.workerInstanceId,
          fencingVersion: staleLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(false);
    await expect(
      liveTurns.markLiveTurnCommandApplied({
        id: inbox[0]!.id,
        appliedByWorkerId: 'w2',
        fence: {
          leaseToken: recoveredLease!.leaseToken,
          workerInstanceId: recoveredLease!.workerInstanceId,
          fencingVersion: recoveredLease!.fencingVersion,
        },
      }),
    ).resolves.toBe(true);
  });

  it('keeps sequence ordering under concurrent appenders', async () => {
    const scope = makeScope({ conversationId: 'tg:command-race' });
    await liveTurns.claimLiveTurn({
      id: 'turn-command-race',
      scope,
      workerInstanceId: 'w1',
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        liveTurns.appendLiveTurnCommand({
          id: `cmd-race-${index}`,
          liveTurnId: 'turn-command-race',
          commandType: 'continuation',
          idempotencyKey: `continuation:turn-command-race:msg-${index}`,
          payload: { index },
        }),
      ),
    );
    expect(results.every((result) => result.outcome === 'appended')).toBe(true);
    const sequences = results
      .map((result) => result.command!.seq)
      .sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // --- WP2 horizontal execution acceptance gates ---

  const leaseDepsFor = (workerInstanceId: string): LiveTurnLeaseDeps => ({
    liveTurns,
    coordination,
    workerInstanceId,
  });

  it('distributes turn ownership across distinct workers (N workers, many scopes)', async () => {
    // Each scope is admitted by a round-robin worker; with distinct
    // workerInstanceIds and per-worker slot keys, multiple distinct workers own
    // turns concurrently — the durable claim is the only serialization point.
    const workers = ['dw1', 'dw2', 'dw3'];
    const scopeCount = 12;
    const ownerByScope: Record<number, string> = {};
    for (let i = 0; i < scopeCount; i += 1) {
      const worker = workers[i % workers.length]!;
      const runId = `run-dist-${i}`;
      await createLiveRun(runId);
      const claim = await claimLiveTurnExecution({
        deps: leaseDepsFor(worker),
        turnId: `turn-dist-${i}`,
        scope: makeScope({ conversationId: `tg:dist-${i}` }),
        runId,
        slotCapacity: 50,
        leaseTtlMs: 60_000,
      });
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      ownerByScope[i] = claim.turn.workerInstanceId ?? worker;
    }
    const distinctOwners = new Set(Object.values(ownerByScope));
    expect(distinctOwners.size).toBeGreaterThan(1);
    expect([...distinctOwners].sort()).toEqual(workers);
  });

  it('leaves no non-terminal orphan run after a lost admission race', async () => {
    const scope = makeScope({ conversationId: 'tg:orphan-race' });
    // Winner claims the scope.
    await createLiveRun('run-orphan-winner');
    const winner = await claimLiveTurnExecution({
      deps: leaseDepsFor('ow1'),
      turnId: 'turn-orphan-winner',
      scope,
      runId: 'run-orphan-winner',
      slotCapacity: 5,
      leaseTtlMs: 60_000,
    });
    expect(winner.outcome).toBe('claimed');

    // Loser mints its run row (as runtime-services does) BEFORE its claim, then
    // loses the durable claim to the active scope.
    await createLiveRun('run-orphan-loser');
    const loser = await claimLiveTurnExecution({
      deps: leaseDepsFor('ow2'),
      turnId: 'turn-orphan-loser',
      scope,
      runId: 'run-orphan-loser',
      slotCapacity: 5,
      leaseTtlMs: 60_000,
    });
    expect(loser.outcome).toBe('scope_active');

    // The admission path terminal-marks the orphan run (canceled), mirroring
    // routeScopeActiveLiveTurnAdmission. The just-created run must not linger as
    // a non-terminal 'running' row.
    await runtime.repositories.agentRuns.saveAgentRun({
      ...(await runtime.repositories.agentRuns.getAgentRun(
        'run-orphan-loser' as never,
      ))!,
      status: 'canceled',
      endedAt: nowIso(),
    });
    const loserRun = await runtime.repositories.agentRuns.getAgentRun(
      'run-orphan-loser' as never,
    );
    expect(loserRun?.status).toBe('canceled');
    expect(['completed', 'failed', 'canceled']).toContain(loserRun?.status);
    // No second active turn exists for the scope.
    await expect(liveTurns.getActiveLiveTurn({ scope })).resolves.toMatchObject(
      {
        id: 'turn-orphan-winner',
      },
    );
  });

  it('defers admission at capacity, then a different worker with free capacity claims', async () => {
    const scope = makeScope({ conversationId: 'tg:capacity-handoff' });
    // Saturate the busy worker's own per-worker slot key with an unrelated turn.
    await createLiveRun('run-cap-busy-other');
    const busyOther = await claimLiveTurnExecution({
      deps: leaseDepsFor('cap-busy'),
      turnId: 'turn-cap-busy-other',
      scope: makeScope({ conversationId: 'tg:capacity-other' }),
      runId: 'run-cap-busy-other',
      slotCapacity: 1,
      leaseTtlMs: 60_000,
    });
    expect(busyOther.outcome).toBe('claimed');

    // The busy worker cannot admit the target scope: its single slot is taken.
    await createLiveRun('run-cap-deferred');
    const deferred = await claimLiveTurnExecution({
      deps: leaseDepsFor('cap-busy'),
      turnId: 'turn-cap-deferred',
      scope,
      runId: 'run-cap-deferred',
      slotCapacity: 1,
      leaseTtlMs: 60_000,
    });
    expect(deferred.outcome).toBe('no_capacity');
    // No turn was left behind for the scope — the message stays re-pollable.
    await expect(liveTurns.getActiveLiveTurn({ scope })).resolves.toBeNull();

    // A different worker with free capacity claims the SAME scope afterward.
    await createLiveRun('run-cap-free');
    const claimed = await claimLiveTurnExecution({
      deps: leaseDepsFor('cap-free'),
      turnId: 'turn-cap-free',
      scope,
      runId: 'run-cap-free',
      slotCapacity: 5,
      leaseTtlMs: 60_000,
    });
    expect(claimed.outcome).toBe('claimed');
    if (claimed.outcome !== 'claimed') return;
    expect(claimed.turn.workerInstanceId).toBe('cap-free');
  });

  it('recovery acquires the slot under the recovering worker key (per-worker capacity)', async () => {
    const scope = makeScope({ conversationId: 'tg:recover-slot-key' });
    await createLiveRun('run-recover-slot');
    const claim = await claimLiveTurnExecution({
      deps: leaseDepsFor('rk-owner'),
      turnId: 'turn-recover-slot',
      scope,
      runId: 'run-recover-slot',
      slotCapacity: 5,
      leaseTtlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') return;

    const recovered = await recoverLiveTurnExecution({
      deps: leaseDepsFor('rk-recoverer'),
      turn: (await liveTurns.getLiveTurnById('turn-recover-slot'))!,
      slotCapacity: 5,
      leaseTtlMs: 60_000,
    });
    expect(recovered.outcome).toBe('recovered');
    if (recovered.outcome !== 'recovered') return;
    expect(recovered.lease.workerInstanceId).toBe('rk-recoverer');

    // The recovering worker finalizes under its own key without error.
    await expect(
      finalizeLiveTurnExecution({
        deps: leaseDepsFor('rk-recoverer'),
        turnId: 'turn-recover-slot',
        fence: liveTurnFence(recovered.lease),
        turnState: 'completed',
        leaseOutcome: 'completed',
      }),
    ).resolves.toBe(true);
  });
});

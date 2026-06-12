import {
  isTerminalLiveTurnState,
  makeLiveTurnScopeKey,
  type LiveTurn,
  type LiveTurnAgentRunCompletion,
  type LiveTurnCommand,
  type LiveTurnCommandAppendResult,
  type LiveTurnCommandType,
  type LiveTurnLeaseFence,
  type LiveTurnScope,
  type LiveTurnState,
} from '@core/domain/ports/live-turns.js';
import type { LiveTurnCoordination } from '@core/application/live-turns/live-turn-lease-service.js';
import type { RunLease } from '@core/domain/ports/worker-coordination.js';

export const FAKE_NOW = '2026-06-10T12:00:00.000Z';

export class FakeLiveTurns {
  turns = new Map<string, LiveTurn>();
  commands: LiveTurnCommand[] = [];
  agentRunCompletions: Array<{ runId: string } & LiveTurnAgentRunCompletion> =
    [];
  /** Ids surfaced by listRecoverableLiveTurns (test-controlled). */
  recoverableIds = new Set<string>();
  /**
   * The real finalizeLiveTurnWithLease settles the run lease in the same
   * transaction as the terminal turn write; the fake mirrors that by
   * settling on this linked coordination repository.
   */
  coordination: FakeCoordination | null = null;
  private seqByTurn = new Map<string, number>();

  private activeForScope(scopeKey: string): LiveTurn | null {
    for (const turn of this.turns.values()) {
      if (turn.scopeKey === scopeKey && !isTerminalLiveTurnState(turn.state)) {
        return turn;
      }
    }
    return null;
  }

  async getActiveLiveTurn(input: {
    scope: LiveTurnScope;
  }): Promise<LiveTurn | null> {
    return this.activeForScope(makeLiveTurnScopeKey(input.scope));
  }

  async getLiveTurnById(id: string): Promise<LiveTurn | null> {
    return this.turns.get(id) ?? null;
  }

  async findActiveLiveTurnByRunId(input: {
    runId: string;
  }): Promise<LiveTurn | null> {
    for (const turn of this.turns.values()) {
      if (turn.runId === input.runId && !isTerminalLiveTurnState(turn.state)) {
        return turn;
      }
    }
    return null;
  }

  async findActiveLiveTurnByStopAlias(input: {
    aliasJid: string;
  }): Promise<LiveTurn | null> {
    for (const turn of this.turns.values()) {
      if (
        !isTerminalLiveTurnState(turn.state) &&
        turn.stopAliasJids.includes(input.aliasJid)
      ) {
        return turn;
      }
    }
    return null;
  }

  private fenceMatchesTurn(
    turnId: string,
    fence: LiveTurnLeaseFence | undefined,
  ): boolean {
    if (!fence) return true;
    const turn = this.turns.get(turnId);
    return (
      !!turn &&
      turn.workerInstanceId === fence.workerInstanceId &&
      turn.leaseToken === fence.leaseToken &&
      turn.fencingVersion === fence.fencingVersion
    );
  }

  async appendLiveTurnCommand(input: {
    id: string;
    liveTurnId: string;
    commandType: LiveTurnCommandType;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    createdByWorkerId?: string | null;
    now?: string;
  }): Promise<LiveTurnCommandAppendResult> {
    const existing = this.commands.find(
      (command) =>
        command.liveTurnId === input.liveTurnId &&
        command.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { outcome: 'replayed', command: existing };
    const turn = this.turns.get(input.liveTurnId);
    if (!turn || isTerminalLiveTurnState(turn.state)) {
      return { outcome: 'rejected', command: null };
    }
    const seq = (this.seqByTurn.get(input.liveTurnId) ?? 0) + 1;
    this.seqByTurn.set(input.liveTurnId, seq);
    const command: LiveTurnCommand = {
      id: input.id,
      liveTurnId: input.liveTurnId,
      scopeKey: turn.scopeKey,
      commandType: input.commandType,
      seq,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      status: 'pending',
      fencingVersion: turn.fencingVersion,
      createdByWorkerId: input.createdByWorkerId ?? null,
      appliedByWorkerId: null,
      rejectedReason: null,
      createdAt: input.now ?? FAKE_NOW,
      appliedAt: null,
    };
    this.commands.push(command);
    return { outcome: 'appended', command };
  }

  async listPendingLiveTurnCommands(input: {
    liveTurnId: string;
    limit: number;
  }): Promise<LiveTurnCommand[]> {
    return this.commands
      .filter(
        (command) =>
          command.liveTurnId === input.liveTurnId &&
          command.status === 'pending',
      )
      .sort((a, b) => a.seq - b.seq)
      .slice(0, input.limit);
  }

  async markLiveTurnCommandApplied(input: {
    id: string;
    appliedByWorkerId: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const command = this.commands.find(
      (candidate) =>
        candidate.id === input.id && candidate.status === 'pending',
    );
    if (!command) return false;
    if (!this.fenceMatchesTurn(command.liveTurnId, input.fence)) return false;
    command.status = 'applied';
    command.appliedByWorkerId = input.appliedByWorkerId;
    command.appliedAt = input.now ?? FAKE_NOW;
    return true;
  }

  async isLiveTurnCommandFenceActive(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const command = this.commands.find(
      (candidate) =>
        candidate.id === input.id && candidate.status === 'pending',
    );
    if (!command) return false;
    return this.fenceMatchesTurn(command.liveTurnId, input.fence);
  }

  async markLiveTurnCommandRejected(input: {
    id: string;
    reason: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const command = this.commands.find(
      (candidate) =>
        candidate.id === input.id && candidate.status === 'pending',
    );
    if (!command) return false;
    if (!this.fenceMatchesTurn(command.liveTurnId, input.fence)) return false;
    command.status = 'rejected';
    command.rejectedReason = input.reason;
    command.appliedAt = input.now ?? FAKE_NOW;
    return true;
  }

  async claimLiveTurn(input: {
    id: string;
    scope: LiveTurnScope;
    workerInstanceId: string;
    runId?: string | null;
    pendingMessage?: Record<string, unknown> | null;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<LiveTurn | null> {
    const scopeKey = makeLiveTurnScopeKey(input.scope);
    if (this.activeForScope(scopeKey)) return null;
    const turn: LiveTurn = {
      id: input.id,
      scopeKey,
      appId: input.scope.appId,
      agentSessionId: input.scope.agentSessionId ?? null,
      conversationId: input.scope.conversationId,
      threadId: input.scope.threadId ?? null,
      runId: input.runId ?? null,
      state: 'claimed',
      pendingMessage: input.pendingMessage ?? null,
      stopAliasJids: input.stopAliasJids ?? [],
      requiredContinuationUserId: input.requiredContinuationUserId ?? null,
      retryCount: 0,
      nextCommandSeq: 1,
      workerInstanceId: input.workerInstanceId,
      leaseToken: null,
      fencingVersion: null,
      createdAt: input.now ?? FAKE_NOW,
      updatedAt: input.now ?? FAKE_NOW,
      endedAt: null,
    };
    this.turns.set(turn.id, turn);
    return turn;
  }

  async transitionLiveTurnState(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    now?: string;
  }): Promise<boolean> {
    const turn = this.turns.get(input.id);
    if (!turn || !input.fromStates.includes(turn.state)) return false;
    turn.state = input.toState;
    if (isTerminalLiveTurnState(input.toState)) {
      turn.endedAt = input.now ?? FAKE_NOW;
    }
    if (input.agentRunCompletion && turn.runId) {
      this.agentRunCompletions.push({
        runId: turn.runId,
        ...input.agentRunCompletion,
      });
    }
    return true;
  }

  async attachLiveTurnLease(input: {
    id: string;
    runId: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const turn = this.turns.get(input.id);
    if (!turn || turn.state !== 'claimed' || turn.leaseToken) return false;
    turn.runId = input.runId;
    turn.workerInstanceId = input.lease.workerInstanceId;
    turn.leaseToken = input.lease.leaseToken;
    turn.fencingVersion = input.lease.fencingVersion;
    return true;
  }

  async updateLiveTurnRouting(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    stopAliasJids: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<boolean> {
    const turn = this.turns.get(input.id);
    if (
      !turn ||
      isTerminalLiveTurnState(turn.state) ||
      !this.fenceMatchesTurn(input.id, input.fence)
    ) {
      return false;
    }
    turn.stopAliasJids = input.stopAliasJids;
    turn.requiredContinuationUserId =
      input.requiredContinuationUserId?.trim() || null;
    return true;
  }

  async transitionLiveTurnStateFenced(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const turn = this.turns.get(input.id);
    if (!turn || !input.fromStates.includes(turn.state)) return false;
    if (!this.fenceMatchesTurn(input.id, input.fence)) return false;
    turn.state = input.toState;
    if (isTerminalLiveTurnState(input.toState)) {
      turn.endedAt = input.now ?? FAKE_NOW;
    }
    return true;
  }

  async finalizeLiveTurnWithLease(input: {
    id: string;
    turnState: 'completed' | 'failed' | 'timed_out';
    leaseOutcome: 'completed' | 'failed' | 'released';
    fence: LiveTurnLeaseFence;
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    requireNoPendingCommands?: boolean;
    now?: string;
  }): Promise<boolean> {
    const turn = this.turns.get(input.id);
    if (!turn?.runId || isTerminalLiveTurnState(turn.state)) return false;
    if (
      input.requireNoPendingCommands &&
      this.commands.some(
        (command) =>
          command.liveTurnId === input.id && command.status === 'pending',
      )
    ) {
      if (this.coordination) {
        await this.coordination.settleRunLease({
          runId: turn.runId,
          leaseToken: input.fence.leaseToken,
          workerInstanceId: input.fence.workerInstanceId,
          fencingVersion: input.fence.fencingVersion,
          outcome: 'released',
          now: input.now,
        });
      }
      return false;
    }
    // Lease-fenced settlement: the run lease is the authority. Mirror the
    // real transaction by settling it first and aborting if it was lost.
    if (this.coordination) {
      const settled = await this.coordination.settleRunLease({
        runId: turn.runId,
        leaseToken: input.fence.leaseToken,
        workerInstanceId: input.fence.workerInstanceId,
        fencingVersion: input.fence.fencingVersion,
        outcome: input.leaseOutcome,
        now: input.now,
      });
      if (!settled) return false;
    } else if (
      turn.leaseToken !== input.fence.leaseToken ||
      turn.fencingVersion !== input.fence.fencingVersion
    ) {
      return false;
    }
    if (input.agentRunCompletion) {
      this.agentRunCompletions.push({
        runId: turn.runId,
        ...input.agentRunCompletion,
      });
    }
    turn.state = input.turnState;
    turn.endedAt = input.now ?? FAKE_NOW;
    return true;
  }

  async takeOverLiveTurn(input: {
    id: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const turn = this.turns.get(input.id);
    if (!turn || isTerminalLiveTurnState(turn.state)) return false;
    if (
      turn.fencingVersion !== null &&
      turn.fencingVersion >= input.lease.fencingVersion
    ) {
      return false;
    }
    turn.state = 'recovered';
    turn.workerInstanceId = input.lease.workerInstanceId;
    turn.leaseToken = input.lease.leaseToken;
    turn.fencingVersion = input.lease.fencingVersion;
    turn.retryCount += 1;
    return true;
  }

  async listRecoverableLiveTurns(input: {
    unleasedStaleBefore: string;
    limit: number;
    now?: string;
  }): Promise<LiveTurn[]> {
    return [...this.turns.values()]
      .filter(
        (turn) =>
          this.recoverableIds.has(turn.id) &&
          !isTerminalLiveTurnState(turn.state),
      )
      .slice(0, input.limit);
  }
}

export interface FakeLeaseRow {
  runId: string;
  leaseToken: string;
  workerInstanceId: string;
  fencingVersion: number;
  status: 'active' | 'expired' | 'released' | 'completed' | 'failed';
}

export class FakeCoordination implements LiveTurnCoordination {
  leases: FakeLeaseRow[] = [];
  slots = new Map<string, Set<string>>();
  private leaseCounter = 0;

  async claimRunLease(input: {
    runId: string;
    jobId?: string | null;
    workerInstanceId: string;
    ttlMs: number;
    now?: string;
  }): Promise<RunLease | null> {
    const history = this.leases.filter((row) => row.runId === input.runId);
    if (history.some((row) => row.status === 'active')) return null;
    const fencingVersion =
      history.reduce((max, row) => Math.max(max, row.fencingVersion), 0) + 1;
    const row: FakeLeaseRow = {
      runId: input.runId,
      leaseToken: `lease-${++this.leaseCounter}`,
      workerInstanceId: input.workerInstanceId,
      fencingVersion,
      status: 'active',
    };
    this.leases.push(row);
    return {
      runId: row.runId,
      jobId: input.jobId ?? null,
      workerInstanceId: row.workerInstanceId,
      leaseToken: row.leaseToken,
      fencingVersion: row.fencingVersion,
      recoveredFromExpiredLease: history.length > 0,
      status: 'active',
      claimedAt: input.now ?? FAKE_NOW,
      expiresAt: input.now ?? FAKE_NOW,
      heartbeatAt: input.now ?? FAKE_NOW,
    };
  }

  expireLease(leaseToken: string): void {
    const row = this.leases.find((lease) => lease.leaseToken === leaseToken);
    if (row) row.status = 'expired';
  }

  async heartbeatRunLease(input: {
    runId: string;
    leaseToken: string;
    ttlMs: number;
    now?: string;
  }): Promise<boolean> {
    return this.leases.some(
      (row) =>
        row.runId === input.runId &&
        row.leaseToken === input.leaseToken &&
        row.status === 'active',
    );
  }

  async settleRunLease(input: {
    runId: string;
    leaseToken: string;
    workerInstanceId?: string;
    fencingVersion?: number;
    outcome: 'completed' | 'failed' | 'released';
    now?: string;
    allowAlreadySettled?: boolean;
  }): Promise<boolean> {
    const row = this.leases.find(
      (lease) =>
        lease.runId === input.runId &&
        lease.leaseToken === input.leaseToken &&
        lease.status === 'active',
    );
    if (!row) return false;
    row.status = input.outcome;
    return true;
  }

  async acquireRunSlot(input: {
    slotKey: string;
    holderId: string;
    capacity: number;
    ttlMs: number;
    runId?: string | null;
    workerInstanceId?: string | null;
    now?: string;
  }): Promise<boolean> {
    const holders = this.slots.get(input.slotKey) ?? new Set<string>();
    if (!holders.has(input.holderId) && holders.size >= input.capacity) {
      return false;
    }
    holders.add(input.holderId);
    this.slots.set(input.slotKey, holders);
    return true;
  }

  async renewRunSlot(input: {
    slotKey: string;
    holderId: string;
    ttlMs: number;
    now?: string;
  }): Promise<boolean> {
    return this.slots.get(input.slotKey)?.has(input.holderId) ?? false;
  }

  async releaseRunSlot(input: {
    slotKey: string;
    holderId: string;
  }): Promise<void> {
    this.slots.get(input.slotKey)?.delete(input.holderId);
  }

  slotHolders(slotKey: string): string[] {
    return [...(this.slots.get(slotKey) ?? [])].sort();
  }
}

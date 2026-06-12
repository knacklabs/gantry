import {
  isTerminalLiveTurnState,
  makeLiveTurnScopeKey,
  type LiveTurn,
  type LiveTurnCommand,
  type LiveTurnCommandAppendResult,
  type LiveTurnCommandType,
  type LiveTurnLeaseFence,
  type LiveTurnScope,
  type LiveTurnState,
} from '@core/domain/ports/live-turns.js';

const NOW = '2026-06-10T12:00:00.000Z';

export function makeFakeLiveTurn(patch: Partial<LiveTurn> = {}): LiveTurn {
  const scope: LiveTurnScope = {
    appId: 'default',
    agentSessionId: 'session-1',
    conversationId: 'tg:fake',
    threadId: null,
  };
  return {
    id: 'turn-1',
    scopeKey: makeLiveTurnScopeKey(scope),
    appId: scope.appId,
    agentSessionId: scope.agentSessionId ?? null,
    conversationId: scope.conversationId,
    threadId: scope.threadId ?? null,
    runId: 'run-1',
    state: 'running',
    pendingMessage: null,
    stopAliasJids: [],
    requiredContinuationUserId: null,
    retryCount: 0,
    nextCommandSeq: 1,
    workerInstanceId: 'w1',
    leaseToken: 'lease-1',
    fencingVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    endedAt: null,
    ...patch,
  };
}

/**
 * In-memory stand-in for the live-turn coordination repository covering the
 * surface used by routing and the owner command pump.
 */
export class FakeLiveTurnInbox {
  turns = new Map<string, LiveTurn>();
  commands: LiveTurnCommand[] = [];
  /** When set, fenced apply marks succeed only for this lease token. */
  activeLeaseTokenByTurn = new Map<string, string>();
  private seqByTurn = new Map<string, number>();

  addTurn(turn: LiveTurn): LiveTurn {
    this.turns.set(turn.id, turn);
    this.activeLeaseTokenByTurn.set(turn.id, turn.leaseToken ?? '');
    return turn;
  }

  async getActiveLiveTurn(input: {
    scope: LiveTurnScope;
  }): Promise<LiveTurn | null> {
    const scopeKey = makeLiveTurnScopeKey(input.scope);
    for (const turn of this.turns.values()) {
      if (turn.scopeKey === scopeKey && !isTerminalLiveTurnState(turn.state)) {
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
      createdAt: input.now ?? NOW,
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
    if (input.fence) {
      const activeToken = this.activeLeaseTokenByTurn.get(command.liveTurnId);
      if (activeToken !== input.fence.leaseToken) return false;
    }
    command.status = 'applied';
    command.appliedByWorkerId = input.appliedByWorkerId;
    command.appliedAt = input.now ?? NOW;
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
    const activeToken = this.activeLeaseTokenByTurn.get(command.liveTurnId);
    return activeToken === input.fence.leaseToken;
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
    if (input.fence) {
      const activeToken = this.activeLeaseTokenByTurn.get(command.liveTurnId);
      if (activeToken !== input.fence.leaseToken) return false;
    }
    command.status = 'rejected';
    command.rejectedReason = input.reason;
    command.appliedAt = input.now ?? NOW;
    return true;
  }

  settleTurn(turnId: string, state: LiveTurnState = 'completed'): void {
    const turn = this.turns.get(turnId);
    if (turn) turn.state = state;
  }
}

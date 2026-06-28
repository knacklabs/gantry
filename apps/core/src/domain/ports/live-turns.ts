/**
 * Durable live interactive turn contract. A live turn is the cross-worker
 * ownership record for one interactive conversation turn; commands are the
 * owner's durable inbox so continuation/stop/prompt traffic that lands on a
 * non-owner worker still reaches the worker that holds the runner process.
 */

export interface LiveTurnScope {
  appId: string;
  agentSessionId?: string | null;
  conversationId: string;
  threadId?: string | null;
}

function scopeComponent(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return encodeURIComponent(trimmed);
}

/**
 * Deterministic scope key for `(appId, agentSessionId, conversationId,
 * threadId)`. Components are URI-encoded so delimiter characters in ids can
 * never collide two scopes; null, undefined, and empty/whitespace components
 * normalize to the same key.
 */
export function makeLiveTurnScopeKey(scope: LiveTurnScope): string {
  return [
    'live',
    `app:${scopeComponent(scope.appId)}`,
    `session:${scopeComponent(scope.agentSessionId)}`,
    `conv:${scopeComponent(scope.conversationId)}`,
    `thread:${scopeComponent(scope.threadId)}`,
  ].join('|');
}

export type LiveTurnState =
  | 'claimed'
  | 'running'
  | 'awaiting_interaction'
  | 'setup_required'
  | 'recovered'
  | 'completed'
  | 'failed'
  | 'timed_out';

export const LIVE_TURN_TERMINAL_STATES = [
  'completed',
  'failed',
  'timed_out',
] as const satisfies readonly LiveTurnState[];

export function isTerminalLiveTurnState(state: LiveTurnState): boolean {
  return (LIVE_TURN_TERMINAL_STATES as readonly LiveTurnState[]).includes(
    state,
  );
}

export interface LiveTurn {
  id: string;
  scopeKey: string;
  appId: string;
  agentSessionId: string | null;
  conversationId: string;
  threadId: string | null;
  runId: string | null;
  state: LiveTurnState;
  pendingMessage: Record<string, unknown> | null;
  stopAliasJids: string[];
  requiredContinuationUserId: string | null;
  retryCount: number;
  nextCommandSeq: number;
  // Projection of the current owner; run_leases remains the fencing
  // authority for writes.
  workerInstanceId: string | null;
  leaseToken: string | null;
  fencingVersion: number | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export type LiveTurnCommandType =
  | 'continuation'
  | 'stop'
  | 'close_stdin'
  | 'new_session'
  | 'compact'
  | 'interaction_resolved';

export type LiveTurnCommandStatus = 'pending' | 'applied' | 'rejected';

export interface LiveTurnCommand {
  id: string;
  liveTurnId: string;
  scopeKey: string;
  commandType: LiveTurnCommandType;
  // Monotonic per live turn; allocated by the repository, never by callers.
  seq: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: LiveTurnCommandStatus;
  // Fence snapshot of the turn at append time, for observability.
  fencingVersion: number | null;
  createdByWorkerId: string | null;
  appliedByWorkerId: string | null;
  rejectedReason: string | null;
  createdAt: string;
  appliedAt: string | null;
}

export type LiveAdmissionWorkItemState =
  | 'queued'
  | 'claimed'
  | 'deferred'
  | 'completed'
  | 'failed'
  | 'canceled';

export const LIVE_ADMISSION_TERMINAL_STATES = [
  'completed',
  'failed',
  'canceled',
] as const satisfies readonly LiveAdmissionWorkItemState[];

export interface LiveAdmissionWorkItem {
  id: string;
  appId: string;
  agentId: string | null;
  agentSessionId: string | null;
  conversationId: string;
  threadId: string | null;
  queueJid: string;
  messageId: string;
  messageCursor: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  idempotencyKey: string;
  state: LiveAdmissionWorkItemState;
  sourceKind: 'message';
  triggerDecision: Record<string, unknown>;
  claimWorkerInstanceId: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  fencingVersion: number;
  retryCount: number;
  failureCount: number;
  deferUntil: string | null;
  deferredReason: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  endedAt: string | null;
}

export interface LiveAdmissionWorkItemEnqueueResult {
  outcome: 'enqueued' | 'replayed';
  item: LiveAdmissionWorkItem;
}

export interface LiveAdmissionWorkItemNotifier {
  notifyLiveAdmissionWorkItem(input: {
    appId: string;
    workItemId: string;
  }): Promise<void>;
}

export interface LiveAdmissionWakeupSource {
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface LiveTurnCommandNotifier {
  notifyLiveTurnCommand(input: {
    liveTurnId: string;
    commandId: string;
  }): Promise<void>;
}

export interface LiveTurnCommandWakeupSource {
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface LiveAdmissionClaimInput {
  appId: string;
  workerInstanceId: string;
  claimToken: string;
  claimExpiresAt: string;
  limit: number;
  now?: string;
}

export interface LiveAdmissionWorkItemRepository {
  /**
   * Durable message-backed admission. The idempotency key is provider delivery
   * identity; replaying a webhook/socket event returns the existing row instead
   * of creating a second live turn candidate.
   */
  enqueueLiveAdmissionWorkItem(input: {
    id: string;
    appId: string;
    agentId?: string | null;
    agentSessionId?: string | null;
    conversationId: string;
    threadId?: string | null;
    queueJid: string;
    messageId: string;
    messageCursor: string;
    senderUserId?: string | null;
    senderDisplayName?: string | null;
    idempotencyKey: string;
    triggerDecision?: Record<string, unknown>;
    now?: string;
  }): Promise<LiveAdmissionWorkItemEnqueueResult>;
  /**
   * Transactionally claims due rows. NOTIFY payloads are only wakeups; workers
   * recover missed or coalesced wakeups by calling this against durable rows.
   */
  claimLiveAdmissionWorkItems(
    input: LiveAdmissionClaimInput,
  ): Promise<LiveAdmissionWorkItem[]>;
  renewLiveAdmissionWorkItemClaim(input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    claimExpiresAt: string;
    now?: string;
  }): Promise<boolean>;
  deferLiveAdmissionWorkItem(input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    reason: 'queued_capacity' | 'listener_degraded' | 'retry';
    deferUntil: string;
    countFailure?: boolean;
    now?: string;
  }): Promise<boolean>;
  settleLiveAdmissionWorkItem(input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    state: Extract<
      LiveAdmissionWorkItemState,
      'completed' | 'failed' | 'canceled'
    >;
    now?: string;
  }): Promise<boolean>;
}

export interface LiveTurnCommandAppendResult {
  // 'appended' persisted a new command; 'replayed' returned the existing
  // command for a reused idempotency key; 'rejected' means the turn is
  // missing or already terminal and command is null.
  outcome: 'appended' | 'replayed' | 'rejected';
  command: LiveTurnCommand | null;
}

export interface LiveTurnLeaseFence {
  leaseToken: string;
  workerInstanceId: string;
  fencingVersion: number;
}

export interface LiveTurnAgentRunCompletion {
  status: 'completed' | 'failed' | 'canceled';
  resultSummary?: string | null;
  errorSummary?: string | null;
}

export interface LiveTurnRepository {
  /**
   * Atomically claim a new live turn for the scope. Returns null when a
   * non-terminal live turn already exists for the scope key (enforced by a
   * partial unique index; concurrent claimers lose via unique violation).
   */
  claimLiveTurn(input: {
    id: string;
    scope: LiveTurnScope;
    workerInstanceId: string;
    runId?: string | null;
    pendingMessage?: Record<string, unknown> | null;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<LiveTurn | null>;
  getActiveLiveTurn(input: { scope: LiveTurnScope }): Promise<LiveTurn | null>;
  getLiveTurnById(id: string): Promise<LiveTurn | null>;
  /**
   * Stop routing: resolve the non-terminal turn that registered `aliasJid`
   * among its durable stop aliases.
   */
  findActiveLiveTurnByStopAlias(input: {
    aliasJid: string;
  }): Promise<LiveTurn | null>;
  /**
   * Prompt routing: resolve the non-terminal turn that owns `runId`, so
   * interaction resolutions can be delivered to the owner inbox.
   */
  findActiveLiveTurnByRunId(input: { runId: string }): Promise<LiveTurn | null>;
  /**
   * Guarded state transition. Returns false when the turn is not currently
   * in one of `fromStates` (e.g. it was settled or recovered concurrently).
   * Terminal transitions stamp endedAt. Unfenced: reserved for maintenance
   * paths (timeout sweeps, claim unwinding) — owner writes must use the
   * fenced variant.
   */
  transitionLiveTurnState(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    now?: string;
  }): Promise<boolean>;
  /**
   * Project the freshly claimed run lease onto the turn. Only valid while
   * the turn is still in 'claimed' with no prior lease attached.
   */
  attachLiveTurnLease(input: {
    id: string;
    runId: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean>;
  updateLiveTurnRouting(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<boolean>;
  /**
   * Owner state transition, fenced by the turn's active run lease. Returns
   * false when the caller's lease coordinates are no longer the run's
   * active lease — the stale owner must drop all writes.
   */
  transitionLiveTurnStateFenced(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean>;
  /**
   * Terminal settlement in one transaction: settles the run lease (fenced
   * on token + worker + fencing version) and writes the terminal turn
   * state. Returns false when the lease was lost; nothing is written.
   */
  finalizeLiveTurnWithLease(input: {
    id: string;
    turnState: Extract<LiveTurnState, 'completed' | 'failed' | 'timed_out'>;
    leaseOutcome: 'completed' | 'failed' | 'released';
    fence: LiveTurnLeaseFence;
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    requireNoPendingCommands?: boolean;
    now?: string;
  }): Promise<boolean>;
  /**
   * Recovery takeover: a new worker that reclaimed the turn's run lease at
   * a higher fencing version stamps itself as owner and marks the turn
   * 'recovered'. Refused once the turn is terminal.
   */
  takeOverLiveTurn(input: {
    id: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean>;
  /**
   * Non-terminal turns that lost their owner: turns whose run lease is no
   * longer active, plus turns that never attached a lease and have been
   * idle since before `unleasedStaleBefore`.
   */
  listRecoverableLiveTurns(input: {
    unleasedStaleBefore: string;
    limit: number;
    now?: string;
  }): Promise<LiveTurn[]>;
  /**
   * The oldest inbound live message in the given routed conversations that is
   * NOT yet being handled by a live turn: it arrived after that conversation's
   * latest live turn (or no turn ever existed) AND no non-terminal turn covers
   * the conversation right now. This is the cross-worker "waiting for capacity"
   * signal — when capacity is free a turn is created near-instantly and advances
   * past these messages, so a non-trivial age means messages are queued behind a
   * saturated fleet. Single ordered statement, limit 1; null when nothing waits.
   */
  getOldestWaitingLiveAdmission(input: {
    conversationJids: string[];
    now?: string;
  }): Promise<{
    conversationJid: string;
    threadId: string | null;
    waitingSince: string;
    ageSeconds: number;
  } | null>;
}

export interface LiveTurnCommandRepository {
  /**
   * Append a command to the owner inbox. Sequence numbers are allocated
   * here, inside the transaction, so ordering can never regress to a
   * process-local counter. Idempotent on idempotencyKey: a duplicate append
   * returns the existing command as 'replayed'. Appends against a missing
   * or terminal turn are 'rejected'.
   */
  appendLiveTurnCommand(input: {
    id: string;
    liveTurnId: string;
    commandType: LiveTurnCommandType;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    createdByWorkerId?: string | null;
    now?: string;
  }): Promise<LiveTurnCommandAppendResult>;
  /** Pending commands in seq order; the owner consumes these. */
  listPendingLiveTurnCommands(input: {
    liveTurnId: string;
    limit: number;
  }): Promise<LiveTurnCommand[]>;
  /**
   * Pre-side-effect ownership check for the command owner. This must pass
   * immediately before local runner side effects are applied.
   */
  isLiveTurnCommandFenceActive(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean>;
  /**
   * Single-shot apply marking. With a fence, the mark only lands while the
   * caller's lease is still the turn's active run lease — a stale owner
   * cannot consume commands that the recovered owner must deliver.
   */
  markLiveTurnCommandApplied(input: {
    id: string;
    appliedByWorkerId: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean>;
  /**
   * Single-shot reject marking. With a fence, rejection is also owner-only:
   * stale owners must not permanently consume commands after recovery.
   */
  markLiveTurnCommandRejected(input: {
    id: string;
    reason: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean>;
}

export interface LiveTurnCoordinationRepository
  extends
    LiveTurnRepository,
    LiveTurnCommandRepository,
    LiveAdmissionWorkItemRepository {}

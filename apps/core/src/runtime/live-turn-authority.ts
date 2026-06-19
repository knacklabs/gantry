import type {
  LiveTurnCommand,
  LiveTurn,
  LiveTurnAgentRunCompletion,
  LiveTurnLeaseFence,
  LiveTurnScope,
} from '../domain/ports/live-turns.js';
import {
  claimLiveTurnExecution,
  finalizeLiveTurnExecution,
  heartbeatLiveTurnLease,
  liveTurnFence,
  liveTurnSlotHolderId,
  liveTurnSlotKey,
  type LiveTurnLeaseDeps,
} from '../application/live-turns/live-turn-lease-service.js';
import {
  createLiveTurnCommandPump,
  type LiveTurnCommandApplyResult,
  type LiveTurnCommandPump,
} from './live-turn-command-pump.js';
import {
  routeLiveCloseStdin,
  routeLiveContinuation,
  routeLiveStop,
} from './live-turn-routing.js';
import { writeResolvedInteractionResponse } from './interaction-resolution-response.js';
import {
  hostExecutionSlotHolderId,
  hostExecutionSlotKey,
} from '../shared/host-capacity.js';

/**
 * Per-worker live-turn authority: the durable replacement for GroupQueue's
 * process-local active state. Admission claims a durable turn + lease +
 * slot; inbound traffic routes through the durable owner inbox; the local
 * registry only mirrors which turns THIS worker owns so commands can be
 * applied to the local runner without polling delay.
 */

type WarnLog = (context: Record<string, unknown>, message: string) => void;

export interface LiveTurnLocalRunnerHooks {
  /** Write the continuation into the local runner's IPC input. */
  applyContinuation: (input: {
    text: string;
    sequence: number;
    threadId: string | null;
  }) => void;
  /** Close the local runner's stdin (end of turn input). */
  applyCloseStdin: () => void;
  /** Stop the local runner (SIGTERM path). */
  applyStop: () => void;
  /** A continuation was delivered; restart user-visible turn UI. */
  onContinuationApplied?: () => void;
  /** A durable interaction resolution arrived for this turn. */
  onInteractionResolved?: (payload: Record<string, unknown>) => boolean;
}

interface ActiveLiveTurnRegistration {
  turnId: string;
  runId: string;
  scope: LiveTurnScope;
  fence: LiveTurnLeaseFence;
  pump: LiveTurnCommandPump;
  // One ownership tick: renew lease + slot, then drain the owner inbox.
  tickTimer: ReturnType<typeof setInterval>;
  hooks: LiveTurnLocalRunnerHooks | null;
  fencedOut: boolean;
}

export type LiveTurnAdmission =
  | { outcome: 'claimed'; turn: LiveTurn; fence: LiveTurnLeaseFence }
  | { outcome: 'scope_active' }
  | { outcome: 'no_capacity' }
  | { outcome: 'lease_unavailable' };

export class LiveTurnAuthority {
  private readonly active = new Map<string, ActiveLiveTurnRegistration>();
  private draining = false;

  constructor(
    private readonly deps: {
      leaseDeps: LiveTurnLeaseDeps;
      slotCapacity: () => number;
      hostSlotCapacity?: () => number;
      hostBudgetCapacity?: () => number;
      leaseTtlMs?: number;
      ownerPollMs?: number;
      warn?: WarnLog;
    },
  ) {}

  /**
   * Stop admitting new live turns during graceful drain. Already-active turns
   * keep running to completion; only fresh admissions are rejected so the run
   * is recovered by the successor live host.
   */
  beginDraining(): void {
    this.draining = true;
  }

  private get leaseTtlMs(): number {
    return this.deps.leaseTtlMs ?? 60_000;
  }

  private warn(context: Record<string, unknown>, message: string): void {
    this.deps.warn?.(context, message);
  }

  /**
   * Cheap durable pre-check used before minting an agent run row: with N
   * pollers, the common case is that another worker already owns the scope, so
   * the caller can route a continuation instead of creating an orphan run.
   */
  getActiveLiveTurn(scope: LiveTurnScope): Promise<LiveTurn | null> {
    return this.deps.leaseDeps.liveTurns.getActiveLiveTurn({ scope });
  }

  /** Whether this worker currently owns the live turn for `queueJid`. */
  ownsQueue(queueJid: string): boolean {
    return this.active.has(queueJid);
  }

  ownedRunId(queueJid: string): string | null {
    return this.active.get(queueJid)?.runId || null;
  }

  ownedFence(queueJid: string): LiveTurnLeaseFence | null {
    return this.active.get(queueJid)?.fence ?? null;
  }

  /**
   * Admission for a new live message turn. On 'claimed', the caller starts
   * the runner and must call registerLocalRunner + finalize. On
   * 'scope_active', the message must be routed as a continuation instead.
   */
  async admit(input: {
    queueJid: string;
    scope: LiveTurnScope;
    turnId: string;
    runId: string;
    pendingMessage?: Record<string, unknown> | null;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
  }): Promise<LiveTurnAdmission> {
    // While draining, refuse new admissions; the released host lease lets a
    // successor claim and recover the turn at a higher fencing version.
    if (this.draining) return { outcome: 'lease_unavailable' };
    const claim = await claimLiveTurnExecution({
      deps: this.deps.leaseDeps,
      turnId: input.turnId,
      scope: input.scope,
      runId: input.runId,
      slotCapacity: this.deps.slotCapacity(),
      hostSlotCapacity: this.deps.hostSlotCapacity?.(),
      hostBudgetCapacity: this.deps.hostBudgetCapacity?.(),
      leaseTtlMs: this.leaseTtlMs,
      pendingMessage: input.pendingMessage,
      stopAliasJids: input.stopAliasJids,
      requiredContinuationUserId: input.requiredContinuationUserId,
    });
    if (claim.outcome !== 'claimed') return { outcome: claim.outcome };
    const fence = liveTurnFence(claim.lease);
    this.registerActiveTurn(input.queueJid, {
      turnId: input.turnId,
      runId: input.runId,
      scope: input.scope,
      fence,
    });
    return { outcome: 'claimed', turn: claim.turn, fence };
  }

  /**
   * Recovery path: an already-claimed lease (takeover) becomes locally
   * owned, e.g. after runLiveTurnRecoveryTick resumed the turn here.
   */
  adoptRecoveredTurn(input: {
    queueJid: string;
    turn: LiveTurn;
    fence: LiveTurnLeaseFence;
  }): void {
    this.registerActiveTurn(input.queueJid, {
      turnId: input.turn.id,
      runId: input.turn.runId ?? '',
      scope: {
        appId: input.turn.appId,
        agentSessionId: input.turn.agentSessionId,
        conversationId: input.turn.conversationId,
        threadId: input.turn.threadId,
      },
      fence: input.fence,
    });
  }

  private registerActiveTurn(
    queueJid: string,
    input: {
      turnId: string;
      runId: string;
      scope: LiveTurnScope;
      fence: LiveTurnLeaseFence;
    },
  ): void {
    const registration: ActiveLiveTurnRegistration = {
      turnId: input.turnId,
      runId: input.runId,
      scope: input.scope,
      fence: input.fence,
      hooks: null,
      fencedOut: false,
      pump: createLiveTurnCommandPump({
        liveTurns: this.deps.leaseDeps.liveTurns,
        turnId: input.turnId,
        fence: input.fence,
        canApplyCommand: (command) =>
          command.commandType === 'interaction_resolved' ||
          !!this.active.get(queueJid)?.hooks,
        handlers: {
          continuation: (command) =>
            this.applyContinuationCommand(
              queueJid,
              command.payload,
              command.seq,
            ),
          stop: () => this.applyLocalHook(queueJid, 'applyStop'),
          close_stdin: () => this.applyLocalHook(queueJid, 'applyCloseStdin'),
          interaction_resolved: (command) =>
            this.applyInteractionResolvedCommand(queueJid, command),
        },
        onError: (err, command) =>
          this.warn(
            { err, queueJid, commandId: command.id, seq: command.seq },
            'Failed to apply live turn command',
          ),
      }),
      tickTimer: setInterval(
        () => {
          void this.tick(queueJid);
        },
        Math.max(250, this.deps.ownerPollMs ?? 1_000),
      ),
    };
    registration.tickTimer.unref?.();
    this.active.set(queueJid, registration);
  }

  /**
   * The local runner is up: install the hooks the durable commands apply
   * to, and move the turn to 'running' (fenced).
   */
  async registerLocalRunner(
    queueJid: string,
    hooks: LiveTurnLocalRunnerHooks,
    routing: {
      stopAliasJids?: string[];
      requiredContinuationUserId?: string | null;
    } = {},
  ): Promise<void> {
    const registration = this.active.get(queueJid);
    if (!registration) return;
    registration.hooks = hooks;
    if (
      routing.stopAliasJids !== undefined ||
      routing.requiredContinuationUserId !== undefined
    ) {
      const routingUpdated = await this.deps.leaseDeps.liveTurns
        .updateLiveTurnRouting({
          id: registration.turnId,
          fence: registration.fence,
          stopAliasJids: routing.stopAliasJids ?? [],
          requiredContinuationUserId: routing.requiredContinuationUserId,
        })
        .catch((err) => {
          this.warn(
            { err, queueJid, turnId: registration.turnId },
            'Failed to update live turn routing metadata',
          );
          return false;
        });
      if (!routingUpdated) {
        this.warn(
          { queueJid, turnId: registration.turnId },
          'Live turn routing metadata was not updated',
        );
      }
    }
    const moved = await this.deps.leaseDeps.liveTurns
      .transitionLiveTurnStateFenced({
        id: registration.turnId,
        toState: 'running',
        fromStates: ['claimed', 'recovered'],
        fence: registration.fence,
      })
      .catch((err) => {
        this.warn(
          { err, queueJid, turnId: registration.turnId },
          'Failed to mark live turn running',
        );
        return false;
      });
    if (!moved) {
      // Either already running (idempotent re-register) or fenced out; a
      // fenced-out owner stops applying commands on its next pump pass.
      this.warn(
        { queueJid, turnId: registration.turnId },
        'Live turn did not transition to running',
      );
    }
    void this.drainQueue(queueJid);
  }

  /** Fenced state transition for the locally owned turn. */
  async transitionOwnedTurn(
    queueJid: string,
    toState: 'running' | 'awaiting_interaction' | 'setup_required',
    fromStates: Array<
      | 'claimed'
      | 'running'
      | 'awaiting_interaction'
      | 'setup_required'
      | 'recovered'
    >,
  ): Promise<boolean> {
    const registration = this.active.get(queueJid);
    if (!registration) return false;
    return this.deps.leaseDeps.liveTurns.transitionLiveTurnStateFenced({
      id: registration.turnId,
      toState,
      fromStates,
      fence: registration.fence,
    });
  }

  /**
   * Inbound follow-up message for an active scope. Returns true when the
   * message was durably queued to the owner (local or remote).
   */
  async routeMessage(input: {
    scope: LiveTurnScope;
    queueJid: string;
    text: string;
    senderUserIds?: readonly string[] | null;
    idempotencyKey: string;
    cursorAfter?: string | null;
  }): Promise<'queued_to_owner' | 'no_active_turn' | 'sender_not_allowed'> {
    const result = await routeLiveContinuation({
      liveTurns: this.deps.leaseDeps.liveTurns,
      scope: input.scope,
      text: input.text,
      senderUserIds: input.senderUserIds,
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      cursorAfter: input.cursorAfter,
      createdByWorkerId: this.deps.leaseDeps.workerInstanceId,
    });
    if (result.outcome === 'queued_to_owner') {
      void this.drainQueue(input.queueJid);
    }
    return result.outcome;
  }

  /** Inbound /stop (or alias). True when routed to an owner. */
  async routeStop(input: {
    scope?: LiveTurnScope;
    aliasJid?: string;
    queueJid: string;
    idempotencyKey: string;
    requestedBy?: string | null;
  }): Promise<boolean> {
    const result = await routeLiveStop({
      liveTurns: this.deps.leaseDeps.liveTurns,
      scope: input.scope,
      aliasJid: input.aliasJid,
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy,
      createdByWorkerId: this.deps.leaseDeps.workerInstanceId,
    });
    if (result.outcome === 'queued_to_owner') {
      void this.drainQueue(input.queueJid);
      return true;
    }
    return false;
  }

  /** Inbound close-stdin signal. True when routed to an owner. */
  async routeCloseStdin(input: {
    scope?: LiveTurnScope;
    aliasJid?: string;
    queueJid: string;
    idempotencyKey: string;
  }): Promise<boolean> {
    const result = await routeLiveCloseStdin({
      liveTurns: this.deps.leaseDeps.liveTurns,
      scope: input.scope,
      aliasJid: input.aliasJid,
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      createdByWorkerId: this.deps.leaseDeps.workerInstanceId,
    });
    if (result.outcome === 'queued_to_owner') {
      void this.drainQueue(input.queueJid);
      return true;
    }
    return false;
  }

  /**
   * Fenced terminal settlement for the locally owned turn; tears down the
   * local registration either way.
   */
  async finalize(
    queueJid: string,
    turnState: 'completed' | 'failed' | 'timed_out',
    agentRunCompletion?: LiveTurnAgentRunCompletion | null,
  ): Promise<boolean> {
    const registration = this.active.get(queueJid);
    if (!registration) return false;
    return this.settleRegistration(
      queueJid,
      registration,
      turnState,
      turnState === 'completed' ? 'completed' : 'failed',
      agentRunCompletion,
    );
  }

  private async settleRegistration(
    queueJid: string,
    registration: ActiveLiveTurnRegistration,
    turnState: 'completed' | 'failed' | 'timed_out',
    leaseOutcome: 'completed' | 'failed' | 'released',
    agentRunCompletion?: LiveTurnAgentRunCompletion | null,
  ): Promise<boolean> {
    await this.drainInteractionResolutionCommands(queueJid, registration);
    const pending =
      await this.deps.leaseDeps.liveTurns.listPendingLiveTurnCommands({
        liveTurnId: registration.turnId,
        limit: 1,
      });
    if (pending.length > 0) {
      this.teardown(queueJid, registration);
      await this.deps.leaseDeps.coordination.settleRunLease({
        runId: registration.runId,
        leaseToken: registration.fence.leaseToken,
        workerInstanceId: registration.fence.workerInstanceId,
        fencingVersion: registration.fence.fencingVersion,
        outcome: 'released',
      });
      await this.deps.leaseDeps.coordination.releaseRunSlot({
        slotKey: liveTurnSlotKey(this.deps.leaseDeps.workerInstanceId),
        holderId: liveTurnSlotHolderId(
          registration.turnId,
          registration.fence.fencingVersion,
        ),
      });
      if (this.deps.hostSlotCapacity) {
        const holderId = hostExecutionSlotHolderId(
          liveTurnSlotHolderId(
            registration.turnId,
            registration.fence.fencingVersion,
          ),
        );
        await this.deps.leaseDeps.coordination.releaseRunSlot({
          slotKey: hostExecutionSlotKey(
            this.deps.leaseDeps.workerInstanceId,
            'interactive',
          ),
          holderId,
        });
        await this.deps.leaseDeps.coordination.releaseRunSlot({
          slotKey: hostExecutionSlotKey(this.deps.leaseDeps.workerInstanceId),
          holderId,
        });
      }
      return false;
    }
    this.teardown(queueJid, registration);
    return finalizeLiveTurnExecution({
      deps: this.deps.leaseDeps,
      turnId: registration.turnId,
      fence: registration.fence,
      turnState,
      leaseOutcome,
      agentRunCompletion,
      hostSlotCapacity: this.deps.hostSlotCapacity?.(),
      hostBudgetCapacity: this.deps.hostBudgetCapacity?.(),
    });
  }

  private async drainInteractionResolutionCommands(
    queueJid: string,
    registration: ActiveLiveTurnRegistration,
  ): Promise<void> {
    for (;;) {
      const pending =
        await this.deps.leaseDeps.liveTurns.listPendingLiveTurnCommands({
          liveTurnId: registration.turnId,
          limit: 1,
        });
      const command = pending[0];
      if (!command || command.commandType !== 'interaction_resolved') return;
      const result = this.applyInteractionResolvedCommand(queueJid, command);
      if (result !== 'applied') {
        this.warn(
          { queueJid, turnId: registration.turnId, commandId: command.id },
          'Failed to apply interaction resolution during live turn finalization',
        );
        return;
      }
      const marked =
        await this.deps.leaseDeps.liveTurns.markLiveTurnCommandApplied({
          id: command.id,
          appliedByWorkerId: registration.fence.workerInstanceId,
          fence: registration.fence,
        });
      if (!marked) return;
    }
  }

  async shutdown(): Promise<void> {
    for (const [queueJid, registration] of [...this.active.entries()]) {
      await this.settleRegistration(
        queueJid,
        registration,
        'failed',
        'released',
        {
          status: 'failed',
          errorSummary: 'Live turn stopped during shutdown.',
        },
      );
    }
  }

  private teardown(
    queueJid: string,
    registration: ActiveLiveTurnRegistration,
  ): void {
    clearInterval(registration.tickTimer);
    this.active.delete(queueJid);
  }

  /**
   * One ownership tick: renew the lease + slot (and detect ownership loss),
   * then apply any pending durable commands locally. Runs at ownerPollMs
   * cadence — short enough that a reclaimed slot or fenced lease stops the
   * local runner promptly.
   */
  private async tick(queueJid: string): Promise<void> {
    const registration = this.active.get(queueJid);
    if (!registration || registration.fencedOut) return;
    const owned = await this.heartbeat(queueJid);
    if (!owned) return;
    await this.drainQueue(queueJid);
  }

  /**
   * Renew lease + slot. Returns false (and tears the turn down) when this
   * worker has lost ownership — a fenced lease or a reclaimed slot — so the
   * local runner is stopped and durable state passes to the recovering
   * owner.
   */
  private async heartbeat(queueJid: string): Promise<boolean> {
    const registration = this.active.get(queueJid);
    if (!registration || registration.fencedOut) return false;
    try {
      const result = await heartbeatLiveTurnLease({
        deps: this.deps.leaseDeps,
        turnId: registration.turnId,
        lease: {
          runId: registration.runId,
          leaseToken: registration.fence.leaseToken,
          fencingVersion: registration.fence.fencingVersion,
        },
        leaseTtlMs: this.leaseTtlMs,
        hostSlotCapacity: this.deps.hostSlotCapacity?.(),
        hostBudgetCapacity: this.deps.hostBudgetCapacity?.(),
      });
      if (!result.leaseAlive || !result.slotHeld) {
        registration.fencedOut = true;
        this.warn(
          {
            queueJid,
            turnId: registration.turnId,
            leaseAlive: result.leaseAlive,
            slotHeld: result.slotHeld,
          },
          'Live turn ownership lost; stopping local runner',
        );
        registration.hooks?.applyStop();
        this.teardown(queueJid, registration);
        return false;
      }
      return true;
    } catch (err) {
      registration.fencedOut = true;
      this.warn(
        { err, queueJid, turnId: registration.turnId },
        'Live turn heartbeat failed; stopping local runner',
      );
      registration.hooks?.applyStop();
      this.teardown(queueJid, registration);
      return false;
    }
  }

  /** Apply pending durable commands to the locally owned runner. */
  async drainQueue(queueJid: string): Promise<void> {
    const registration = this.active.get(queueJid);
    if (!registration || registration.fencedOut) return;
    if (!registration.hooks) {
      const pending =
        await this.deps.leaseDeps.liveTurns.listPendingLiveTurnCommands({
          liveTurnId: registration.turnId,
          limit: 1,
        });
      const first = pending[0];
      if (first && first.commandType !== 'interaction_resolved') return;
    }
    try {
      await registration.pump.drain();
    } catch (err) {
      this.warn(
        { err, queueJid, turnId: registration.turnId },
        'Live turn command drain failed',
      );
    }
  }

  private applyContinuationCommand(
    queueJid: string,
    payload: Record<string, unknown>,
    sequence: number,
  ): LiveTurnCommandApplyResult {
    const registration = this.active.get(queueJid);
    const hooks = registration?.hooks;
    if (!hooks) return 'retry';
    const text = typeof payload.text === 'string' ? payload.text : null;
    if (!text) return 'rejected';
    const threadId =
      typeof payload.threadId === 'string' ? payload.threadId : null;
    hooks.applyContinuation({ text, sequence, threadId });
    hooks.onContinuationApplied?.();
    return 'applied';
  }

  private applyInteractionResolvedCommand(
    queueJid: string,
    command: LiveTurnCommand,
  ): LiveTurnCommandApplyResult {
    const handler = this.active.get(queueJid)?.hooks?.onInteractionResolved;
    const applied = handler
      ? handler(command.payload)
      : writeResolvedInteractionResponse(command.payload);
    return applied ? 'applied' : 'rejected';
  }

  private applyLocalHook(
    queueJid: string,
    hook: 'applyStop' | 'applyCloseStdin',
  ): LiveTurnCommandApplyResult {
    const registration = this.active.get(queueJid);
    const hooks = registration?.hooks;
    if (!hooks) return 'retry';
    hooks[hook]();
    return 'applied';
  }
}

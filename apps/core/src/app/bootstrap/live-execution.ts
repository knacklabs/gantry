import { randomUUID } from 'node:crypto';

import type {
  LiveAdmissionWakeupSource,
  LiveTurn,
  LiveTurnScope,
} from '../../domain/ports/live-turns.js';
import type {
  AgentTodoCardStatus,
  AgentTodoRender,
} from '../../domain/ports/task-lifecycle.js';
import type { GroupMessageRunContext } from '../../runtime/group-queue-types.js';
import type { RunLease } from '../../domain/ports/worker-coordination.js';
import type { RuntimeLease } from '../../domain/ports/runtime-lease.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { NewMessage } from '../../domain/types.js';
import type { ProcessRole } from './roles/process-role.js';
import {
  parseThreadQueueKey,
  makeThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';
import type { LiveTurnAuthority } from '../../runtime/live-turn-authority.js';
import type { LiveTurnLeaseDeps } from '../../application/live-turns/live-turn-lease-service.js';
import {
  runLiveTurnRecoveryTick,
  startLiveTurnRecoveryLoop,
  type LiveTurnRecoveryLoop,
} from '../../runtime/live-turn-recovery.js';
import {
  recoverPendingMessages as defaultRecoverPendingMessages,
  type MessageLoopDeps,
} from '../../runtime/message-loop.js';
import {
  startLiveAdmissionWorkLoop as defaultStartLiveAdmissionWorkLoop,
  type LiveAdmissionWorkLoopHandle,
} from '../../runtime/live-admission-work-loop.js';
import { markPendingContinuationCommandsApplied } from './live-turn-continuation.js';
import { routeScopeActiveLiveTurnAdmissionFromCursor } from './live-recovery-coordinator.js';
import { resolveConversationBrowserProfile } from '../../shared/browser-profile-scope.js';
import { getProfile } from '../../runtime/browser-profiles.js';
import {
  consumeBrowserProfileActivity,
  isBrowserProfileSyncEnabled,
  snapshotBrowserProfile,
} from '../../runtime/browser-profile-sync.js';
import { computeHostCapacityPlan } from '../../shared/host-capacity.js';

type WarnLog = (context: Record<string, unknown>, message: string) => void;
type InfoLog = (obj: string | Record<string, unknown>, msg?: string) => void;

/**
 * Browser teardown + cross-worker snapshot at live-turn finalize. Resolves the
 * conversation profile, read-and-clears the per-profile activity flag set by the
 * IPC browser handler, and (only when the browser was actually used this turn)
 * closes the backends + session and snapshots the quiescent bytes. No-op when
 * the snapshot coordinator is unregistered (workstation single-process) or no
 * browser activity was recorded.
 */
export interface LiveTurnBrowserFinalizer {
  (input: {
    queueJid: string;
    runId?: string | null;
    fencingVersion?: number;
  }): Promise<void>;
}

export function buildLiveTurnBrowserFinalizer(deps: {
  getConversationRoutes: () => Record<string, { folder: string }>;
  closeBrowserSession?: (profileName: string) => Promise<unknown>;
  closeBrowserToolBackends?: (profileName: string) => Promise<void>;
  warn: WarnLog;
}): LiveTurnBrowserFinalizer {
  return async (input) => {
    const { chatJid } = parseThreadQueueKey(input.queueJid);
    const folder = deps.getConversationRoutes()[chatJid]?.folder;
    if (!folder) return;
    const profileName = resolveConversationBrowserProfile({
      agentId: folder,
      workspaceKey: folder,
      conversationId: chatJid,
    });
    // Read-and-clear: even when sync is disabled we must clear so the flag does
    // not leak across turns on a long-lived worker.
    const used = consumeBrowserProfileActivity(profileName);
    if (!used) return;
    try {
      if (!isBrowserProfileSyncEnabled()) return;
      await deps.closeBrowserToolBackends?.(profileName);
      await deps.closeBrowserSession?.(profileName);
      const profile = getProfile(profileName);
      if (!profile) return;
      await snapshotBrowserProfile({
        profileName,
        profileDir: profile.dir,
        userDataDir: profile.userDataDir,
        snapshotRunId: input.runId ?? null,
        snapshotFencingVersion: input.fencingVersion ?? 0,
      });
    } catch (err) {
      deps.warn(
        { err, queueJid: input.queueJid, profileName },
        'Failed to snapshot live-turn browser profile after finalize',
      );
    }
  };
}

interface AdmissionOpsRepository {
  getAgentTurnContext?: (input: {
    agentFolder: string;
    executionProviderId: ExecutionProviderId;
    conversationJid: string;
    threadId: string | null;
    conversationKind?: 'channel' | 'dm';
    hydrateMemory: boolean;
  }) => Promise<
    | {
        appId: string;
        agentSessionId: string;
        providerSessionId?: string | null;
      }
    | undefined
  >;
  createSessionAgentRun?: (input: {
    agentSessionId: string;
    executionProviderId: ExecutionProviderId;
    providerSessionId?: string | null;
    cause: 'message';
  }) => Promise<string | undefined>;
  completeSessionAgentRun?: (input: {
    runId: string;
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    errorSummary?: string | null;
  }) => Promise<unknown>;
  getMessagesSince?: (
    conversationJid: string,
    sinceCursor: string,
    limit?: number,
    options?: { threadId?: string | null },
  ) => Promise<NewMessage[]>;
}

interface AdmissionApp {
  getConversationRoutes(): Record<
    string,
    { folder: string; conversationKind?: 'channel' | 'dm' }
  >;
  processGroupMessages: (
    queueJid: string,
    options: {
      queued: boolean;
      existingRunId?: string;
      existingRunLeaseToken?: string;
      existingRunLeaseWorkerInstanceId?: string;
      existingRunLeaseFencingVersion?: number;
      finalRetry?: boolean;
      onRunResult?: (result: 'success' | 'error' | 'stopped' | null) => void;
      onFirstProgress?: (input: {
        jid: string;
        messageRef: string;
      }) => Promise<void> | void;
      onLiveStopActionToken?: (token: string) => Promise<void> | void;
    },
  ) => Promise<boolean>;
  getOrRecoverCursor: (queueJid: string) => Promise<string>;
  setAgentCursor: (queueJid: string, cursor: string) => void;
  saveState: () => Promise<void> | void;
}

/**
 * Build the GroupQueue message processor. With WP2 horizontal execution EVERY
 * live worker runs this — there is no live-host lease gate on admission. The
 * durable one-active-turn-per-scope claim (`uq_live_turns_active_scope`) is the
 * serialization point: when two pollers race the same scope, the loser sees
 * `scope_active` and routes its message to the durable owner inbox instead of
 * starting a second run.
 *
 * Orphan-run avoidance (WP2): N pollers racing the same scope must not each mint
 * a `running` agent_run row that loses the claim. We do a cheap
 * `getActiveLiveTurn(scope)` pre-check BEFORE creating the run; if a turn is
 * already active, the continuation routes WITHOUT creating a run row. The
 * residual race (claimed between pre-check and claim) is cleaned up by
 * terminal-marking the just-created run on a non-`claimed` admission outcome, so
 * no non-terminal orphan run rows survive a lost race.
 */
export function buildLiveAdmissionProcessor(input: {
  liveTurnAuthority: LiveTurnAuthority | undefined;
  app: AdmissionApp;
  opsRepository: AdmissionOpsRepository;
  executionAdapter: { id: ExecutionProviderId };
  messageFetchPageSize: number;
  timezone: string;
  enqueueMessageCheck: (queueJid: string) => void;
  warn: WarnLog;
  addReaction?: (
    jid: string,
    messageRef: string,
    emoji: string,
  ) => Promise<void>;
  finalizeAgentTodo?: (
    jid: string,
    input: {
      threadId?: string | null;
      cardKind?: AgentTodoRender['cardKind'];
      status: AgentTodoCardStatus;
    },
  ) => Promise<boolean>;
  finalizeBrowserForLiveTurn?: LiveTurnBrowserFinalizer;
}): (queueJid: string, context?: GroupMessageRunContext) => Promise<boolean> {
  const {
    liveTurnAuthority,
    app,
    opsRepository,
    executionAdapter,
    messageFetchPageSize,
    timezone,
    warn,
    finalizeAgentTodo,
    finalizeBrowserForLiveTurn,
  } = input;

  const routeScopeActive = (
    scope: LiveTurnScope,
    queueJid: string,
    liveRunId: string,
    chatJid: string,
    threadId: string | null,
    replayCursor: string,
  ): Promise<boolean> =>
    routeScopeActiveLiveTurnAdmissionFromCursor({
      scope,
      queueJid,
      liveRunId,
      chatJid,
      threadId,
      replayCursor,
      messageFetchPageSize,
      timezone,
      getMessagesSince: opsRepository.getMessagesSince?.bind(opsRepository),
      setAgentCursor: app.setAgentCursor,
      saveState: app.saveState,
      enqueueMessageCheck: input.enqueueMessageCheck,
      routeMessage: liveTurnAuthority!.routeMessage.bind(liveTurnAuthority),
      completeSessionAgentRun:
        opsRepository.completeSessionAgentRun?.bind(opsRepository),
    });

  return async (
    queueJid: string,
    context?: GroupMessageRunContext,
  ): Promise<boolean> => {
    if (!liveTurnAuthority) {
      return app.processGroupMessages(queueJid, {
        queued: true,
        finalRetry: context?.finalRetry === true,
      });
    }
    const { chatJid, threadId } = parseThreadQueueKey(queueJid);
    let liveRunId = liveTurnAuthority.ownedRunId(queueJid) ?? undefined;
    let liveRunFence = liveTurnAuthority.ownedFence(queueJid);
    if (!liveTurnAuthority.ownsQueue(queueJid)) {
      const route = app.getConversationRoutes()[chatJid];
      if (!route) return false;
      const executionProviderId =
        resolveRuntimeExecutionProviderId(executionAdapter);
      const turnContext = await opsRepository.getAgentTurnContext?.({
        agentFolder: route.folder,
        executionProviderId,
        conversationJid: chatJid,
        threadId: threadId ?? null,
        conversationKind: route.conversationKind,
        hydrateMemory: false,
      });
      if (!turnContext?.agentSessionId) return false;
      const scope: LiveTurnScope = {
        appId: turnContext.appId,
        agentSessionId: turnContext.agentSessionId,
        conversationId: chatJid,
        threadId: threadId ?? null,
      };
      const replayCursor = await app.getOrRecoverCursor(queueJid);
      // Pre-check: with N pollers the common case is that another worker already
      // owns this scope. Route the continuation WITHOUT minting a run row that
      // would just lose the claim and become an orphan.
      const existing = await liveTurnAuthority.getActiveLiveTurn(scope);
      if (existing) {
        return routeScopeActive(
          scope,
          queueJid,
          /* liveRunId */ '',
          chatJid,
          threadId ?? null,
          replayCursor,
        );
      }
      liveRunId = await opsRepository.createSessionAgentRun?.({
        agentSessionId: turnContext.agentSessionId,
        executionProviderId,
        providerSessionId: turnContext.providerSessionId,
        cause: 'message',
      });
      if (!liveRunId) return false;
      const admission = await liveTurnAuthority.admit({
        queueJid,
        scope,
        turnId: `live-turn:${randomUUID()}`,
        runId: liveRunId,
        pendingMessage: {
          kind: 'message_cursor',
          queueJid,
          cursorBefore: replayCursor,
        },
      });
      if (admission.outcome !== 'claimed') {
        if (admission.outcome === 'scope_active') {
          // Residual race: a turn became active between the pre-check and the
          // claim. routeScopeActive terminal-marks liveRunId (canceled), so the
          // just-created run never lingers as a non-terminal orphan.
          return routeScopeActive(
            scope,
            queueJid,
            liveRunId,
            chatJid,
            threadId ?? null,
            replayCursor,
          );
        }
        // no_capacity / lease_unavailable: terminal-mark the orphan run. The
        // message cursor is NOT advanced, so the deferred message is re-polled
        // and a worker with free capacity admits it next tick.
        await opsRepository.completeSessionAgentRun?.({
          runId: liveRunId,
          status:
            admission.outcome === 'lease_unavailable' ? 'failed' : 'canceled',
          errorSummary: `Live-turn admission did not claim the run: ${admission.outcome}`,
        });
        return false;
      }
      liveRunFence = admission.fence;
    }
    try {
      let liveRunResult: 'success' | 'error' | 'stopped' | null = null;
      const success = await app.processGroupMessages(queueJid, {
        queued: true,
        finalRetry: context?.finalRetry === true,
        existingRunId: liveRunId,
        ...(liveRunFence
          ? {
              existingRunLeaseToken: liveRunFence.leaseToken,
              existingRunLeaseWorkerInstanceId: liveRunFence.workerInstanceId,
              existingRunLeaseFencingVersion: liveRunFence.fencingVersion,
            }
          : {}),
        onRunResult: (result) => {
          liveRunResult = result;
        },
        onFirstProgress: ({ jid, messageRef }) =>
          input.addReaction?.(jid, messageRef, 'seen').catch(() => undefined),
        onLiveStopActionToken: async (token) => {
          await liveTurnAuthority.registerStopAliases(queueJid, [token]);
        },
      });
      const terminalSuccess =
        success && (liveRunResult === 'success' || liveRunResult === null);
      const terminalHandled =
        terminalSuccess || (success && liveRunResult === 'stopped');
      // Snapshot the browser profile (if used) BEFORE finalizing the live turn,
      // while this worker still owns the run lease fence.
      await finalizeBrowserForLiveTurn?.({
        queueJid,
        runId: liveRunId ?? null,
        fencingVersion: liveRunFence?.fencingVersion,
      });
      const finalized = await liveTurnAuthority.finalize(
        queueJid,
        terminalHandled ? 'completed' : 'failed',
        {
          status: terminalSuccess
            ? 'completed'
            : liveRunResult === 'stopped'
              ? 'canceled'
              : 'failed',
          ...(terminalSuccess
            ? { resultSummary: 'Live turn completed.' }
            : liveRunResult === 'stopped'
              ? { errorSummary: 'Live turn stopped by request.' }
              : {
                  errorSummary: 'Live turn failed.',
                }),
        },
      );
      if (finalized && finalizeAgentTodo) {
        await finalizeAgentTodo(chatJid, {
          threadId: threadId ?? null,
          status: terminalSuccess
            ? 'done'
            : liveRunResult === 'stopped'
              ? 'stopped'
              : 'failed',
        }).catch((todoErr) => {
          warn(
            { err: todoErr, queueJid },
            'Failed to finalize live-turn todo card',
          );
        });
      }
      return terminalHandled && finalized;
    } catch (err) {
      // Snapshot on failure too: the browser may have persisted new cookies/
      // logins before the turn errored. Best-effort; never mask the original err.
      await finalizeBrowserForLiveTurn?.({
        queueJid,
        runId: liveRunId ?? null,
        fencingVersion: liveRunFence?.fencingVersion,
      }).catch((snapshotErr) => {
        warn(
          { err: snapshotErr, queueJid },
          'Failed to snapshot live-turn browser profile after error',
        );
      });
      const finalized = await liveTurnAuthority
        .finalize(queueJid, 'failed', {
          status: 'failed',
          errorSummary: 'Live turn failed during message processing.',
        })
        .catch((finalizeErr) => {
          warn(
            { err: finalizeErr, queueJid },
            'Failed to finalize live turn after message processing error',
          );
          return false;
        });
      void finalized;
      if (finalized && finalizeAgentTodo) {
        await finalizeAgentTodo(chatJid, {
          threadId: threadId ?? null,
          status: 'failed',
        }).catch((todoErr) => {
          warn(
            { err: todoErr, queueJid },
            'Failed to finalize live-turn todo card after message processing error',
          );
        });
      }
      throw err;
    }
  };
}

export interface LiveExecutionServicesHandle {
  /** Stop the always-on admission loop (drain/handoff). */
  stopAdmission: () => void;
  /** Stop the recovery coordinator loop if this worker held it. */
  stopRecovery: () => void;
  /** Current admission loop handle (registered as the active loop for shutdown). */
  admissionLoop: LiveAdmissionWorkLoopHandle | undefined;
  /** Current recovery loop handle, set only while this worker is coordinator. */
  recoveryLoop: LiveTurnRecoveryLoop | undefined;
}

/**
 * Hooks for the waiting-status monitor (a sibling of the recovery coordinator).
 * Started/stopped in lockstep with the coordinator so detection + sends happen
 * on exactly one worker. Absent ⇒ the monitor is not started (tests / processes
 * with no waiting-status delivery wired).
 */
export interface WaitingStatusCoordination {
  /** Start the monitor; returns a handle with stop + oldest-age accessor. */
  start: () => { stop: () => void; oldestWaitingSeconds: () => number };
  /** Register the active monitor (or undefined when stopped) for /metrics + shutdown. */
  register: (
    handle: { oldestWaitingSeconds: () => number } | undefined,
  ) => void;
}

/**
 * Start the live execution services for a live-capable worker.
 *
 * WP2 split:
 *  - The admission loop runs UNCONDITIONALLY on every live worker. When the
 *    live-turn repository exposes durable admission claims, it processes
 *    queue-scoped work items instead of scanning every route. It is NOT gated
 *    by any recovery lease.
 *  - The recovery COORDINATOR — startup `recoverPendingMessages` plus the
 *    periodic recovery sweep — is the only lease-gated piece. Exactly one worker
 *    holds the `runtime:live-recovery-coordinator:default` advisory lease and
 *    runs recovery; recovered turns resume ON THE COORDINATOR under a strictly
 *    higher fencing version. If the coordinator lacks slot capacity for a turn,
 *    `runLiveTurnRecoveryTick` defers that turn (capacityExhausted) to the next
 *    tick rather than crash-looping.
 */
export function startLiveExecutionServices(input: {
  appId: string;
  processRole?: ProcessRole;
  app: AdmissionApp & {
    queue: {
      getPolicy: () => { maxMessageRuns: number; maxRetries?: number };
      enqueueMessageCheck: (queueJid: string) => void | boolean;
    };
  };
  liveTurnAuthority: LiveTurnAuthority | undefined;
  liveTurnLeaseDeps: LiveTurnLeaseDeps | undefined;
  messageLoopDeps: MessageLoopDeps;
  recoveryCoordinator: RecoveryCoordinatorPort | undefined;
  isEligibleToRecoverLiveTurn: (turn: LiveTurn) => boolean | Promise<boolean>;
  alertNoEligibleLiveTurnRecoverer:
    | ((turn: LiveTurn) => Promise<void> | void)
    | undefined;
  recoverPendingMessages?: typeof defaultRecoverPendingMessages;
  startLiveAdmissionWorkLoop?: typeof defaultStartLiveAdmissionWorkLoop;
  liveAdmissionWakeupSource?: LiveAdmissionWakeupSource;
  registerActiveAdmissionLoop: (
    loop: LiveAdmissionWorkLoopHandle | undefined,
  ) => void;
  registerActiveRecoveryLoop: (loop: LiveTurnRecoveryLoop | undefined) => void;
  /** Waiting-status monitor, started/stopped with the coordinator. */
  waitingStatus?: WaitingStatusCoordination;
  onPollingCrash: (err: unknown) => void;
  info: InfoLog;
  warn: WarnLog;
  addReaction?: (
    jid: string,
    messageRef: string,
    emoji: string,
  ) => Promise<void>;
}): LiveExecutionServicesHandle {
  const {
    app,
    liveTurnAuthority,
    liveTurnLeaseDeps,
    messageLoopDeps,
    recoveryCoordinator,
    isEligibleToRecoverLiveTurn,
    alertNoEligibleLiveTurnRecoverer,
    registerActiveAdmissionLoop,
    registerActiveRecoveryLoop,
    waitingStatus,
    onPollingCrash,
    info,
    warn,
  } = input;
  const recoverPendingMessages =
    input.recoverPendingMessages ?? defaultRecoverPendingMessages;
  const startLiveAdmissionWorkLoop =
    input.startLiveAdmissionWorkLoop ?? defaultStartLiveAdmissionWorkLoop;

  const handle: LiveExecutionServicesHandle = {
    admissionLoop: undefined,
    recoveryLoop: undefined,
    stopAdmission: () => undefined,
    stopRecovery: () => undefined,
  };

  const hasDurableAdmissionClaims =
    !!liveTurnLeaseDeps &&
    typeof liveTurnLeaseDeps.liveTurns.claimLiveAdmissionWorkItems ===
      'function';
  // Always-on: every live worker claims queue-scoped durable work items. There
  // is intentionally no route-wide message scanner fallback.
  if (!hasDurableAdmissionClaims) {
    warn(
      { processRole: input.processRole },
      'Live admission requires durable admission claims; live admission disabled for this role',
    );
    return handle;
  }
  const admissionLoop = startLiveAdmissionWorkLoop({
    liveAdmissions: liveTurnLeaseDeps.liveTurns,
    appId: input.appId,
    workerInstanceId: liveTurnLeaseDeps.workerInstanceId,
    messageLoopDeps,
    maxRetryCount: app.queue.getPolicy().maxRetries,
    warn,
  });
  const unsubscribeLiveAdmissionWakeup =
    input.liveAdmissionWakeupSource?.subscribe(() => admissionLoop.trigger());
  handle.admissionLoop = admissionLoop;
  registerActiveAdmissionLoop(admissionLoop);
  admissionLoop.done.catch((err) => onPollingCrash(err));
  handle.stopAdmission = () => {
    unsubscribeLiveAdmissionWakeup?.();
    admissionLoop.stop();
    registerActiveAdmissionLoop(undefined);
  };

  // Lease-gated: recovery coordinator. Only the holder runs startup pending
  // message recovery + the periodic recovery sweep + the waiting-status monitor.
  let waitingMonitor: { stop: () => void } | undefined;
  const startCoordinator = (): void => {
    if (handle.recoveryLoop || waitingMonitor) return;
    info(
      'Live-recovery-coordinator lease held; starting recovery coordinator (pending message recovery, recovery sweep, waiting-status monitor)',
    );
    void Promise.resolve(recoverPendingMessages(messageLoopDeps)).catch((err) =>
      warn({ err }, 'Pending message recovery failed'),
    );
    // The waiting-status monitor is a coordinator singleton but does not need
    // the live-turn authority/lease deps (it only reads the durable store and
    // sends a transient status), so it starts even when those are absent.
    if (waitingStatus) {
      const monitor = waitingStatus.start();
      waitingMonitor = monitor;
      waitingStatus.register(monitor);
    }
    if (!liveTurnAuthority || !liveTurnLeaseDeps) return;
    const recoveryLoop = startLiveTurnRecoveryLoop({
      intervalMs: 20_000,
      tick: () => {
        const hostCapacityPlan = computeHostCapacityPlan({
          queue: app.queue.getPolicy(),
          processRole: input.processRole,
        });
        return runLiveTurnRecoveryTick({
          deps: liveTurnLeaseDeps,
          slotCapacity: app.queue.getPolicy().maxMessageRuns,
          hostSlotCapacity: hostCapacityPlan.interactiveCapacity,
          hostBudgetCapacity: hostCapacityPlan.budget,
          leaseTtlMs: 60_000,
          unleasedStaleMs: 30_000,
          isEligible: isEligibleToRecoverLiveTurn,
          onNoEligibleRecoverer: alertNoEligibleLiveTurnRecoverer,
          warn,
          // Recovered turns resume ON THE COORDINATOR: this worker adopts the
          // turn locally and re-enqueues the message check so its owner drains
          // pending input under the higher fencing version.
          resumeRecoveredTurn: async ({ turn, lease }) =>
            resumeRecoveredTurn({
              turn,
              lease,
              app,
              liveTurnAuthority,
              liveTurnLeaseDeps,
              warn,
            }),
        });
      },
      warn,
    });
    handle.recoveryLoop = recoveryLoop;
    registerActiveRecoveryLoop(recoveryLoop);
  };
  const stopCoordinator = (): void => {
    handle.recoveryLoop?.stop();
    registerActiveRecoveryLoop(undefined);
    handle.recoveryLoop = undefined;
    waitingMonitor?.stop();
    waitingMonitor = undefined;
    waitingStatus?.register(undefined);
  };
  handle.stopRecovery = stopCoordinator;

  if (!recoveryCoordinator) {
    // Single-process embedding (workstation, no lease manager): this process is
    // also the coordinator.
    startCoordinator();
    return handle;
  }
  recoveryCoordinator.onTransition({
    onAcquired: () => startCoordinator(),
    onLost: (err) => {
      warn(
        { err },
        'Live-recovery-coordinator lease lost; stopping recovery coordinator (live admission continues)',
      );
      stopCoordinator();
    },
  });
  return handle;
}

export interface RecoveryCoordinatorPort {
  onTransition: (handlers: {
    onAcquired: (lease: RuntimeLease) => void;
    onLost: (err: Error) => void;
  }) => void;
}

async function resumeRecoveredTurn(input: {
  turn: LiveTurn;
  lease: RunLease;
  app: AdmissionApp & {
    queue: { enqueueMessageCheck: (queueJid: string) => void };
  };
  liveTurnAuthority: LiveTurnAuthority;
  liveTurnLeaseDeps: LiveTurnLeaseDeps;
  warn: WarnLog;
}): Promise<void> {
  const { turn, lease, app, liveTurnAuthority, liveTurnLeaseDeps, warn } =
    input;
  const queueJid = makeThreadQueueKey(
    turn.conversationId,
    turn.threadId ?? undefined,
  );
  liveTurnAuthority.adoptRecoveredTurn({
    queueJid,
    turn,
    fence: {
      leaseToken: lease.leaseToken,
      workerInstanceId: lease.workerInstanceId,
      fencingVersion: lease.fencingVersion,
    },
  });
  const pendingMessage =
    turn.pendingMessage &&
    typeof turn.pendingMessage === 'object' &&
    !Array.isArray(turn.pendingMessage)
      ? turn.pendingMessage
      : null;
  const replayQueueJid =
    pendingMessage?.queueJid === queueJid ? queueJid : null;
  const cursorBefore =
    typeof pendingMessage?.cursorBefore === 'string'
      ? pendingMessage.cursorBefore
      : null;
  if (!replayQueueJid || cursorBefore === null) {
    warn(
      { turnId: turn.id, runId: turn.runId, queueJid },
      'Recovered live turn has no replayable pending message; failing closed',
    );
    await liveTurnAuthority.finalize(queueJid, 'failed', {
      status: 'failed',
      errorSummary: 'Recovered live turn had no replayable pending message.',
    });
    return;
  }
  const pendingCommands =
    await liveTurnLeaseDeps.liveTurns.listPendingLiveTurnCommands({
      liveTurnId: turn.id,
      limit: 5000,
    });
  app.setAgentCursor(queueJid, cursorBefore);
  await app.saveState();
  app.queue.enqueueMessageCheck(queueJid);
  await markPendingContinuationCommandsApplied({
    liveTurns: liveTurnLeaseDeps.liveTurns,
    commands: pendingCommands,
    fence: lease,
  });
}

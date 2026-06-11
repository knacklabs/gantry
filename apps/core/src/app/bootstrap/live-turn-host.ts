import type { RuntimeLease } from '../../domain/ports/runtime-lease.js';
import type { LiveTurnScope } from '../../domain/ports/live-turns.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { NewMessage } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';
import { parseThreadQueueKey } from '../../shared/thread-queue-key.js';
import { buildLiveTurnContinuation } from './live-turn-continuation.js';

export const LIVE_TURN_HOST_LEASE_KEY = 'runtime:live-turn-host:default';

/** Bounded exponential backoff for the standby acquirer loop. */
export const LIVE_TURN_HOST_LEASE_BASE_BACKOFF_MS = 1_000;
export const LIVE_TURN_HOST_LEASE_MAX_BACKOFF_MS = 30_000;

export interface LiveTurnHostLeasePort {
  tryAcquire: (key: string) => Promise<RuntimeLease | undefined>;
}

interface LiveTurnRuntimeSettings {
  runtime: {
    liveTurns: {
      enabled: boolean;
    };
  };
}

export interface LiveTurnHostLeaseManager {
  /** Resolves with the lease once acquired, or undefined when live turns are disabled. */
  whenAcquired: () => Promise<RuntimeLease | undefined>;
  /** The current lease if this worker owns live turns, otherwise undefined. */
  getLease: () => RuntimeLease | undefined;
  /** Stop the standby acquirer and release the lease if held (drain handoff). */
  stop: () => Promise<void>;
}

interface AcquisitionLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

interface StartLiveTurnHostLeaseAcquisitionDeps {
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
  logger?: AcquisitionLogger;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Acquire the singleton live-turn host lease without blocking the rest of
 * startup. Fleet v1 runs 1 live host + N job workers, so a standby worker that
 * loses the race for the lease must boot fine as a job-only worker and keep
 * retrying. When the current holder drains and releases the lease, a standby
 * acquirer takes it over. Acquisition never throws and never blocks; callers
 * await {@link LiveTurnHostLeaseManager.whenAcquired} only where they actually
 * need ownership.
 */
export function startLiveTurnHostLeaseAcquisition(input: {
  runtimeSettings: LiveTurnRuntimeSettings;
  leases: LiveTurnHostLeasePort;
  deps?: StartLiveTurnHostLeaseAcquisitionDeps;
}): LiveTurnHostLeaseManager {
  const deps = input.deps ?? {};
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const random = deps.random ?? Math.random;
  const log = deps.logger ?? logger;
  const baseBackoffMs =
    deps.baseBackoffMs ?? LIVE_TURN_HOST_LEASE_BASE_BACKOFF_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? LIVE_TURN_HOST_LEASE_MAX_BACKOFF_MS;

  let lease: RuntimeLease | undefined;
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveAcquired!: (value: RuntimeLease | undefined) => void;
  const acquired = new Promise<RuntimeLease | undefined>((resolve) => {
    resolveAcquired = resolve;
  });

  if (!input.runtimeSettings.runtime.liveTurns.enabled) {
    stopped = true;
    resolveAcquired(undefined);
    return {
      whenAcquired: () => acquired,
      getLease: () => undefined,
      stop: async () => {},
    };
  }

  const backoffMs = (attempt: number): number => {
    const exponential = Math.min(
      maxBackoffMs,
      baseBackoffMs * Math.pow(2, attempt),
    );
    // Full jitter avoids a thundering herd of standby workers retrying in lockstep.
    return Math.floor(random() * exponential);
  };

  const attempt = async (attemptIndex: number): Promise<void> => {
    if (stopped) return;
    let acquiredLease: RuntimeLease | undefined;
    try {
      acquiredLease = await input.leases.tryAcquire(LIVE_TURN_HOST_LEASE_KEY);
    } catch (err) {
      log.warn(
        { err, attempt: attemptIndex },
        'Failed to acquire live-turn host lease; standing by as a job-only worker',
      );
    }
    if (stopped) {
      await acquiredLease?.release().catch(() => undefined);
      return;
    }
    if (acquiredLease) {
      lease = acquiredLease;
      resolveAcquired(acquiredLease);
      return;
    }
    log.info(
      { attempt: attemptIndex },
      'Another runtime owns live turns; standing by as a job-only worker until the lease is released',
    );
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = undefined;
      void attempt(attemptIndex + 1);
    }, backoffMs(attemptIndex));
  };

  void attempt(0);

  return {
    whenAcquired: () => acquired,
    getLease: () => lease,
    stop: async () => {
      stopped = true;
      if (pendingTimer !== undefined) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = undefined;
      }
      const held = lease;
      lease = undefined;
      resolveAcquired(undefined);
      await held?.release();
    },
  };
}

export interface LiveTurnScopeRepository {
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
      }
    | undefined
  >;
}

interface LiveTurnScopeApp {
  getConversationRoutes(): Record<
    string,
    { folder: string; conversationKind?: 'channel' | 'dm' }
  >;
}

export async function liveTurnScopeForQueue(input: {
  app: LiveTurnScopeApp;
  opsRepository: LiveTurnScopeRepository;
  executionAdapter: { id: ExecutionProviderId };
  queueJid: string;
}): Promise<LiveTurnScope | null> {
  const { app, opsRepository, executionAdapter, queueJid } = input;
  const { chatJid, threadId } = parseThreadQueueKey(queueJid);
  const route = app.getConversationRoutes()[chatJid];
  if (!route) return null;
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
  if (!turnContext?.agentSessionId) return null;
  return {
    appId: turnContext.appId,
    agentSessionId: turnContext.agentSessionId,
    conversationId: chatJid,
    threadId: threadId ?? null,
  };
}

export async function routeScopeActiveLiveTurnAdmission(input: {
  scope: LiveTurnScope;
  queueJid: string;
  liveRunId: string;
  continuation?: {
    text: string;
    senderUserIds: readonly string[];
    idempotencyKey: string;
    cursorAfter?: string | null;
    onRouted: () => Promise<void> | void;
  } | null;
  routeMessage?: (input: {
    scope: LiveTurnScope;
    queueJid: string;
    text: string;
    senderUserIds?: readonly string[] | null;
    idempotencyKey: string;
    cursorAfter?: string | null;
  }) => Promise<'queued_to_owner' | 'no_active_turn' | 'sender_not_allowed'>;
  completeSessionAgentRun?: (input: {
    runId: string;
    status: 'canceled' | 'failed';
    errorSummary: string;
  }) => Promise<unknown>;
}): Promise<boolean> {
  const routed =
    input.continuation && input.routeMessage
      ? await input.routeMessage({
          scope: input.scope,
          queueJid: input.queueJid,
          text: input.continuation.text,
          senderUserIds: input.continuation.senderUserIds,
          idempotencyKey: input.continuation.idempotencyKey,
          cursorAfter: input.continuation.cursorAfter,
        })
      : 'no_active_turn';
  if (routed === 'queued_to_owner') {
    await input.continuation?.onRouted();
  }
  await input.completeSessionAgentRun?.({
    runId: input.liveRunId,
    status: routed === 'queued_to_owner' ? 'canceled' : 'failed',
    errorSummary:
      routed === 'queued_to_owner'
        ? 'Live-turn admission routed the message to the active owner.'
        : `Live-turn admission could not route to active owner: ${routed}`,
  });
  return routed === 'queued_to_owner';
}

export async function routeScopeActiveLiveTurnAdmissionFromCursor(input: {
  scope: LiveTurnScope;
  queueJid: string;
  liveRunId: string;
  chatJid: string;
  threadId: string | null;
  replayCursor: string;
  maxMessagesPerPrompt: number;
  timezone: string;
  getMessagesSince?: (
    conversationJid: string,
    sinceCursor: string,
    limit?: number,
    options?: { threadId?: string | null },
  ) => Promise<NewMessage[]>;
  setAgentCursor: (queueJid: string, cursor: string) => void;
  saveState: () => Promise<void> | void;
  routeMessage: NonNullable<
    Parameters<typeof routeScopeActiveLiveTurnAdmission>[0]['routeMessage']
  >;
  completeSessionAgentRun?: Parameters<
    typeof routeScopeActiveLiveTurnAdmission
  >[0]['completeSessionAgentRun'];
}): Promise<boolean> {
  const messages = await input.getMessagesSince?.(
    input.chatJid,
    input.replayCursor,
    input.maxMessagesPerPrompt,
    { threadId: input.threadId },
  );
  return routeScopeActiveLiveTurnAdmission({
    scope: input.scope,
    queueJid: input.queueJid,
    liveRunId: input.liveRunId,
    continuation: buildLiveTurnContinuation({
      queueJid: input.queueJid,
      messages,
      timezone: input.timezone,
      setAgentCursor: input.setAgentCursor,
      saveState: input.saveState,
    }),
    routeMessage: input.routeMessage,
    completeSessionAgentRun: input.completeSessionAgentRun,
  });
}

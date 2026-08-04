import { logger } from '../../infrastructure/logging/logger.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';
import { collectPendingMessagesSince } from '../../runtime/pending-message-replay.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { findConversationRouteForQueue, parseAgentThreadQueueKey, } from '../../shared/thread-queue-key.js';
import { buildLiveTurnContinuation } from './live-turn-continuation.js';
import { encodeGroupMessageCursor, toGroupMessageCursor, } from '../../shared/message-cursor.js';
/**
 * WP2: the singleton lease is now a RECOVERY COORDINATOR election, not a live
 * host election. Live-turn admission runs on every live worker (distributed);
 * only startup pending-message recovery and the periodic recovery sweep are
 * gated by this lease so they run on exactly one worker.
 */
export const LIVE_RECOVERY_COORDINATOR_LEASE_KEY = 'runtime:live-recovery-coordinator:default';
/** Bounded exponential backoff for the standby acquirer loop. */
export const LIVE_RECOVERY_COORDINATOR_LEASE_BASE_BACKOFF_MS = 1_000;
export const LIVE_RECOVERY_COORDINATOR_LEASE_MAX_BACKOFF_MS = 30_000;
/**
 * Acquire the singleton live-recovery-coordinator lease without blocking the
 * rest of startup. WP2: every live worker polls and admits turns; this lease
 * elects only the single worker that runs recovery (startup pending-message
 * recovery + the periodic recovery sweep). A worker that loses the race boots
 * fine and keeps retrying; when the holder drains and releases, a standby
 * acquirer takes over. Acquisition never throws and never blocks; callers await
 * {@link LiveRecoveryCoordinatorLeaseManager.whenAcquired} only where they
 * actually need to be the coordinator.
 */
export function startLiveRecoveryCoordinatorLeaseAcquisition(input) {
    const deps = input.deps ?? {};
    const liveExecutionEnabled = input.liveExecutionEnabled ?? true;
    const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    const random = deps.random ?? Math.random;
    const log = deps.logger ?? logger;
    const baseBackoffMs = deps.baseBackoffMs ?? LIVE_RECOVERY_COORDINATOR_LEASE_BASE_BACKOFF_MS;
    const maxBackoffMs = deps.maxBackoffMs ?? LIVE_RECOVERY_COORDINATOR_LEASE_MAX_BACKOFF_MS;
    let lease;
    let stopped = false;
    let pendingTimer;
    let transitionHandlers;
    let resolveAcquired;
    const acquired = new Promise((resolve) => {
        resolveAcquired = resolve;
    });
    if (!input.runtimeSettings.runtime.liveTurns.enabled ||
        !liveExecutionEnabled) {
        stopped = true;
        resolveAcquired(undefined);
        return {
            whenAcquired: () => acquired,
            getLease: () => undefined,
            onTransition: () => { },
            stop: async () => { },
        };
    }
    const backoffMs = (attempt) => {
        const exponential = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt));
        // Full jitter avoids a thundering herd of standby workers retrying in lockstep.
        return Math.floor(random() * exponential);
    };
    const scheduleRetry = (nextAttemptIndex) => {
        pendingTimer = setTimeoutFn(() => {
            pendingTimer = undefined;
            void attempt(nextAttemptIndex);
        }, backoffMs(nextAttemptIndex - 1));
        // A standby retry must never keep an otherwise-exiting process alive.
        pendingTimer.unref?.();
    };
    const handleLost = (err) => {
        if (stopped || !lease)
            return;
        lease = undefined;
        log.warn({ err }, 'Live-recovery-coordinator lease lost; stopping recovery coordinator and re-entering standby acquisition');
        transitionHandlers?.onLost(err);
        void attempt(0);
    };
    const attempt = async (attemptIndex) => {
        if (stopped)
            return;
        let acquiredLease;
        try {
            acquiredLease = await input.leases.tryAcquire(LIVE_RECOVERY_COORDINATOR_LEASE_KEY);
        }
        catch (err) {
            log.warn({ err, attempt: attemptIndex }, 'Failed to acquire live-recovery-coordinator lease; continuing to poll/admit without coordinating recovery');
        }
        if (stopped) {
            await acquiredLease?.release().catch(() => undefined);
            return;
        }
        if (acquiredLease) {
            lease = acquiredLease;
            acquiredLease.onLost?.(handleLost);
            resolveAcquired(acquiredLease);
            transitionHandlers?.onAcquired(acquiredLease);
            return;
        }
        log.info({ attempt: attemptIndex }, 'Another runtime is the live recovery coordinator; this worker keeps admitting live turns and stands by to coordinate recovery');
        scheduleRetry(attemptIndex + 1);
    };
    void attempt(0);
    return {
        whenAcquired: () => acquired,
        getLease: () => lease,
        onTransition: (handlers) => {
            transitionHandlers = handlers;
            // Replay: the lease may already be held (fast acquisition on boot)
            // before the consumer registers; fire onAcquired so services start.
            if (lease)
                handlers.onAcquired(lease);
        },
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
export async function liveTurnScopeForQueue(input) {
    const { app, opsRepository, executionAdapter, queueJid } = input;
    const { chatJid, threadId, providerAccountId } = parseAgentThreadQueueKey(queueJid);
    const route = findConversationRouteForQueue(app.getConversationRoutes(), queueJid, (candidate) => agentIdForFolder(candidate.folder));
    if (!route)
        return null;
    const executionProviderId = (await app.resolveExecutionProviderId?.(route, chatJid)) ??
        resolveRuntimeExecutionProviderId(executionAdapter);
    const turnContext = await opsRepository.getAgentTurnContext?.({
        agentFolder: route.folder,
        executionProviderId,
        conversationJid: chatJid,
        threadId: threadId ?? null,
        providerAccountId: providerAccountId ?? null,
        conversationKind: route.conversationKind,
        hydrateMemory: false,
    });
    if (!turnContext?.agentSessionId)
        return null;
    return {
        appId: turnContext.appId,
        agentSessionId: turnContext.agentSessionId,
        conversationId: chatJid,
        threadId: threadId ?? null,
    };
}
export async function routeScopeActiveLiveTurnAdmission(input) {
    const routed = input.continuation && input.routeMessage
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
    // The orphan-avoidance pre-check routes a continuation BEFORE any run row is
    // created (empty liveRunId), so there is nothing to terminal-mark in that
    // case. Only settle the run when admission actually minted one.
    if (input.liveRunId) {
        await input.completeSessionAgentRun?.({
            runId: input.liveRunId,
            status: routed === 'queued_to_owner' ? 'canceled' : 'failed',
            errorSummary: routed === 'queued_to_owner'
                ? 'Live-turn admission routed the message to the active owner.'
                : `Live-turn admission could not route to active owner: ${routed}`,
        });
    }
    return routed === 'queued_to_owner';
}
export async function routeScopeActiveLiveTurnAdmissionFromCursor(input) {
    const replay = input.getMessagesSince
        ? await collectPendingMessagesSince({
            getMessagesSince: input.getMessagesSince,
            chatJid: input.chatJid,
            sinceCursor: input.replayCursor,
            pageSize: input.messageFetchPageSize,
            options: {
                threadId: input.threadId,
                providerAccountId: parseAgentThreadQueueKey(input.queueJid)
                    .providerAccountId,
            },
        })
        : undefined;
    const messages = replay?.messages;
    if (messages?.length && input.handleActiveControlMessage) {
        const nextMessage = messages[0];
        if (await input.handleActiveControlMessage(nextMessage)) {
            input.setAgentCursor(input.queueJid, encodeGroupMessageCursor(toGroupMessageCursor(nextMessage)));
            await input.saveState();
            return true;
        }
    }
    const controlIndex = messages?.findIndex((message) => input.isActiveControlMessage?.(message) === true);
    const replayMessages = controlIndex === undefined || controlIndex < 0
        ? messages
        : messages?.slice(0, controlIndex);
    const routed = await routeScopeActiveLiveTurnAdmission({
        scope: input.scope,
        queueJid: input.queueJid,
        liveRunId: input.liveRunId,
        continuation: buildLiveTurnContinuation({
            queueJid: input.queueJid,
            sinceCursor: input.replayCursor,
            messages: replayMessages,
            timezone: input.timezone,
            setAgentCursor: input.setAgentCursor,
            saveState: input.saveState,
        }),
        routeMessage: input.routeMessage,
        completeSessionAgentRun: input.completeSessionAgentRun,
    });
    if (routed && (replay?.hasMore || (controlIndex ?? -1) >= 0)) {
        input.enqueueMessageCheck?.(input.queueJid);
    }
    return routed;
}

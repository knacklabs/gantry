import { RICH_INTERACTION_NATIVE_FALLBACK_TEXT, } from '../../domain/types.js';
import { DurableInteractionPersistenceError } from '../../application/interactions/pending-interaction-durability.js';
export function createUserQuestionResponder(input) {
    const userQuestionResponseCache = new Map();
    const cancelledQuestionKeys = new Set();
    const queuedCancellations = new Map();
    const activeCancellationHandlers = new Map();
    const activeCancellationTargets = new Map();
    const questionScopeKey = (request) => JSON.stringify([
        request.appId || 'default',
        request.sourceAgentFolder,
        request.requestId,
    ]);
    async function settleQueuedCancellation(cancellation) {
        const key = questionScopeKey(cancellation);
        const cancel = activeCancellationHandlers.get(key);
        if (!cancel)
            return 'queued';
        const result = await cancel(cancellation);
        if (result === 'settled' || result === 'already_decided') {
            queuedCancellations.delete(key);
            return 'settled';
        }
        // The durable IPC directory owns retries; a local timer can race it and cannot survive restart.
        return 'queued';
    }
    async function settleQueuedCancellationSafely(cancellation) {
        const key = questionScopeKey(cancellation);
        const targetJid = activeCancellationTargets.get(key);
        try {
            return await settleQueuedCancellation(cancellation);
        }
        catch (err) {
            input.interactionLifecycle.logger.error({
                err,
                targetJid,
                requestId: cancellation.requestId,
                message: 'Target channel user question cancellation failed',
            });
            return 'queued';
        }
    }
    async function dispatchUserAnswer(request, onPromptDelivered) {
        const key = questionScopeKey(request);
        if (queuedCancellations.delete(key)) {
            return { requestId: request.requestId, answers: {} };
        }
        if (!request.targetJid) {
            return { requestId: request.requestId, answers: {} };
        }
        const channel = input.findBoundChannel(request.targetJid, request);
        const questionSurface = channel
            ? input.asUserQuestionSurface(channel)
            : undefined;
        if (!channel || !questionSurface) {
            return { requestId: request.requestId, answers: {} };
        }
        try {
            const cancelPendingQuestion = (cancellation) => questionSurface.cancelPendingQuestion?.(cancellation) ??
                Promise.resolve('not_found');
            activeCancellationHandlers.set(key, cancelPendingQuestion);
            activeCancellationTargets.set(key, request.targetJid);
            try {
                return await questionSurface.requestUserAnswer(request.targetJid, request, (messageId, questionIndex) => {
                    input.interactionLifecycle.resetStreaming?.(request.targetJid, {
                        providerAccountId: request.providerAccountId,
                        threadId: request.threadId,
                    });
                    const cancellation = queuedCancellations.get(key);
                    if (cancellation) {
                        void settleQueuedCancellationSafely(cancellation);
                    }
                    if (questionIndex === undefined) {
                        onPromptDelivered?.(messageId);
                        return;
                    }
                    const deliveredIndexes = questionSurface.questionIndexesForDeliveredPrompt?.(request, questionIndex) ?? [questionIndex];
                    deliveredIndexes.forEach((index) => onPromptDelivered?.(messageId, index));
                });
            }
            finally {
                activeCancellationHandlers.delete(key);
                activeCancellationTargets.delete(key);
                queuedCancellations.delete(key);
            }
        }
        catch (err) {
            if (err instanceof DurableInteractionPersistenceError) {
                questionSurface.dropPendingInteraction?.('question', request);
                throw err;
            }
            input.interactionLifecycle.logger.error({
                err,
                targetJid: request.targetJid,
                requestId: request.requestId,
                message: 'Target channel user question flow failed',
            });
            return { requestId: request.requestId, answers: {} };
        }
    }
    async function requestUserAnswer(request) {
        const requestKey = questionScopeKey(request);
        const cached = userQuestionResponseCache.get(requestKey);
        if (cached)
            return cached;
        const response = await dispatchUserAnswer(request);
        if (cancelledQuestionKeys.delete(requestKey)) {
            userQuestionResponseCache.delete(requestKey);
        }
        else {
            userQuestionResponseCache.set(requestKey, response);
        }
        return response;
    }
    async function cancelUserQuestion(cancellation) {
        const key = questionScopeKey(cancellation);
        queuedCancellations.set(key, cancellation);
        cancelledQuestionKeys.add(key);
        userQuestionResponseCache.delete(key);
        const cancel = activeCancellationHandlers.get(key);
        if (!cancel)
            return 'queued';
        return settleQueuedCancellationSafely(cancellation);
    }
    return {
        requestUserAnswer,
        cancelUserQuestion,
        clear: () => {
            userQuestionResponseCache.clear();
            cancelledQuestionKeys.clear();
            queuedCancellations.clear();
            activeCancellationHandlers.clear();
            activeCancellationTargets.clear();
        },
    };
}
export function createRichInteractionRenderer(input) {
    return async (jid, request, options) => {
        const providerAccountId = options?.providerAccountId ?? request.providerAccountId;
        const channel = input.findBoundChannel(jid, providerAccountId);
        const surface = channel
            ? input.asRichInteractionSurface(channel)
            : undefined;
        if (surface) {
            try {
                if ((await surface.renderRichInteraction(jid, request)) !== false) {
                    return true;
                }
            }
            catch (err) {
                input.logger.error({
                    err,
                    jid,
                    requestId: request.requestId,
                    message: 'Target channel rich interaction render failed',
                });
            }
        }
        await input.sendMessage(jid, `${RICH_INTERACTION_NATIVE_FALLBACK_TEXT}\n\n${request.descriptor.rich?.fallbackText ?? request.descriptor.fallbackText ?? ''}`.trim(), {
            ...(request.threadId ? { threadId: request.threadId } : {}),
            ...(providerAccountId ? { providerAccountId } : {}),
        });
        return true;
    };
}
// Renders an agent todo/plan to the bound channel, live-updating in place.
// Best-effort: a missing channel or a render failure is logged and swallowed so
// it never breaks the originating todo_update tool response. Per-conversation
// throttle: the first update renders immediately (leading edge); rapid follow-ups
// within the window are coalesced and only the latest flushes once the window
// closes (trailing edge). This keeps the plan visible promptly while avoiding
// edit flicker and provider rate limits when an agent updates the plan in a burst.
// Message-id state is in-memory by design: an interrupted run loses its pending
// question regardless, and a restarted todo simply posts one fresh message, so
// durable cross-restart persistence is intentionally not modeled here.
const AGENT_TODO_RENDER_THROTTLE_MS = 1000;
export function createAgentTodoRenderer(input) {
    const windows = new Map();
    // ponytail: ceiling is the latest in-memory render only; todo state stays non-durable.
    const latest = new Map();
    const getSurface = (jid, options) => {
        const channel = input.findBoundChannel(jid, options?.providerAccountId);
        return channel ? input.asAgentTodoSurface(channel) : undefined;
    };
    const flush = async (jid, render, options) => {
        const surface = getSurface(jid, options);
        if (!surface)
            return false;
        try {
            return (await surface.renderAgentTodo(jid, render)) !== false;
        }
        catch (err) {
            input.logger.error({
                err,
                jid,
                message: 'Target channel agent todo render failed',
            });
            return false;
        }
    };
    const renderKey = (jid, render, options) => `${options?.providerAccountId ?? ''}:${jid}:${render.threadId ?? ''}:${render.cardKind ?? 'todo'}`;
    const openWindow = (key, jid, options) => {
        const timer = setTimeout(() => {
            const entry = windows.get(key);
            if (!entry)
                return;
            const next = entry.pending;
            if (next) {
                entry.pending = null;
                openWindow(key, jid, options);
                void flush(jid, next, options);
            }
            else {
                windows.delete(key);
            }
        }, AGENT_TODO_RENDER_THROTTLE_MS);
        // Don't let a pending plan flush keep the process alive on shutdown.
        timer.unref?.();
        windows.set(key, { pending: windows.get(key)?.pending ?? null, timer });
    };
    const renderTodo = (async (jid, render, options) => {
        if (!jid || !getSurface(jid, options))
            return false;
        const key = renderKey(jid, render, options);
        latest.set(key, render);
        if (render.flush) {
            const existing = windows.get(key);
            if (existing) {
                clearTimeout(existing.timer);
                windows.delete(key);
            }
            return flush(jid, render, options);
        }
        const existing = windows.get(key);
        if (existing) {
            // Within the throttle window: keep only the latest plan; it flushes on close.
            existing.pending = render;
            return true;
        }
        openWindow(key, jid, options);
        return flush(jid, render, options);
    });
    renderTodo.finalize = async (jid, final, options) => {
        if (!jid || !getSurface(jid, options))
            return false;
        const key = renderKey(jid, {
            summary: null,
            items: [],
            threadId: final.threadId ?? null,
            cardKind: final.cardKind ?? 'todo',
        }, options);
        const render = latest.get(key);
        if (!render)
            return false;
        return renderTodo(jid, {
            ...render,
            status: final.status,
            stop: undefined,
            updatedAt: new Date().toISOString(),
            flush: true,
        }, options);
    };
    return renderTodo;
}

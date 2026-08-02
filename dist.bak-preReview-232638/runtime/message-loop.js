import { getTriggerPattern, MAX_MESSAGES_PER_PROMPT, MESSAGE_FETCH_PAGE_SIZE, TIMEZONE, } from '../config/index.js';
import { encodeGroupMessageCursor, toGroupMessageCursor, } from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import { formatMessages } from '../messaging/router.js';
import { isSenderControlAllowed, isTriggerAllowed, loadSenderControlAllowlist, loadSenderAllowlist, } from '../platform/sender-allowlist.js';
import { extractSessionCommand, isSessionCommandAllowed, } from '../session/session-commands.js';
import { makeAgentThreadQueueKey, normalizeThreadQueueId, parseAgentThreadQueueKey, } from '../shared/thread-queue-key.js';
import { buildPendingMessagesContinuationIdempotencyKey, collectPendingMessagesSince, } from './pending-message-replay.js';
import { resolveNonSelfSenderIds } from './session-resume-runtime.js';
function resolveMessageRepository(deps) {
    if (!deps.opsRepository) {
        throw new Error('Message loop requires a runtime message repository');
    }
    return deps.opsRepository;
}
async function resolveConversationRoute(deps, chatJid, agentId, threadId, providerAccountId) {
    const conversationRoutes = deps.getConversationRoutes();
    const selectedAgentId = agentId ? agentIdForFolder(agentId) : null;
    const selectedRoute = selectConversationRouteEntry(conversationRoutes, chatJid, selectedAgentId, threadId, providerAccountId);
    if (selectedRoute)
        return selectedRoute[1];
    for (const routeKey of persistedRouteLookupKeys(chatJid, selectedAgentId, threadId, providerAccountId)) {
        const persistedRoute = await deps.opsRepository?.getConversationRoute?.(routeKey);
        if (persistedRoute &&
            (!selectedAgentId ||
                agentIdForFolder(persistedRoute.folder) === selectedAgentId)) {
            const persistedKey = parseAgentThreadQueueKey(routeKey);
            conversationRoutes[routeKey] = persistedRoute;
            const canonicalRouteKey = makeAgentThreadQueueKey(persistedKey.chatJid, agentIdForFolder(persistedRoute.folder), persistedKey.threadId, persistedKey.providerAccountId);
            conversationRoutes[canonicalRouteKey] = persistedRoute;
            return persistedRoute;
        }
    }
    return undefined;
}
function selectConversationRouteEntry(conversationRoutes, chatJid, selectedAgentId, threadId, providerAccountId) {
    const requestedThreadId = normalizeThreadQueueId(threadId);
    const requestedProviderAccountId = providerAccountId?.trim();
    const exactThreadRoutes = [];
    const wholeConversationRoutes = [];
    for (const entry of Object.entries(conversationRoutes)) {
        const [key, route] = entry;
        const parsed = parseAgentThreadQueueKey(key);
        if (parsed.chatJid !== chatJid)
            continue;
        if (requestedProviderAccountId &&
            route.providerAccountId !== requestedProviderAccountId) {
            continue;
        }
        if (selectedAgentId && agentIdForFolder(route.folder) !== selectedAgentId) {
            continue;
        }
        if (parsed.threadId) {
            if (requestedThreadId && parsed.threadId === requestedThreadId) {
                exactThreadRoutes.push(entry);
            }
            continue;
        }
        wholeConversationRoutes.push(entry);
    }
    return preferAgentQualifiedRoute(requestedThreadId && exactThreadRoutes.length > 0
        ? exactThreadRoutes
        : wholeConversationRoutes);
}
function preferAgentQualifiedRoute(routes) {
    let fallback;
    for (const entry of routes) {
        if (parseAgentThreadQueueKey(entry[0]).agentId)
            return entry;
        fallback ??= entry;
    }
    return fallback;
}
function persistedRouteLookupKeys(chatJid, selectedAgentId, threadId, providerAccountId) {
    const keys = [];
    if (selectedAgentId && normalizeThreadQueueId(threadId)) {
        keys.push(makeAgentThreadQueueKey(chatJid, selectedAgentId, threadId, providerAccountId));
    }
    if (normalizeThreadQueueId(threadId)) {
        keys.push(makeAgentThreadQueueKey(chatJid, null, threadId, providerAccountId));
    }
    if (selectedAgentId) {
        keys.push(makeAgentThreadQueueKey(chatJid, selectedAgentId, null, providerAccountId));
    }
    keys.push(makeAgentThreadQueueKey(chatJid, null, null, providerAccountId));
    return [...new Set(keys)];
}
function saveStateBestEffort(deps, chatJid) {
    Promise.resolve(deps.saveState()).catch((err) => logger.warn({ chatJid, err }, 'Failed to persist message cursor state'));
}
async function hasTriggerOwnedThreadRoot(input) {
    const rootCandidates = await input.opsRepository.getMessagesSince(input.chatJid, '', MESSAGE_FETCH_PAGE_SIZE, {
        threadId: input.threadId,
        providerAccountId: input.group.providerAccountId,
    });
    if (rootCandidates.length === 0)
        return false;
    const allowlistCfg = loadSenderAllowlist();
    return rootCandidates.some((message) => message.thread_id === input.threadId &&
        !message.reply_to_message_id &&
        input.triggerPattern.test(message.content.trim()) &&
        (message.is_from_me ||
            isTriggerAllowed(input.chatJid, message.sender, allowlistCfg, input.group.folder)));
}
async function enqueueMessageCheck(deps, queueJid) {
    const accepted = await deps.queue.enqueueMessageCheck(queueJid);
    return accepted === false ? 'queued_capacity' : 'completed';
}
async function processQueueMessages(deps, queueJid, groupMessages, preloadedInitialReplay, options = {}) {
    const opsRepository = resolveMessageRepository(deps);
    const { chatJid, threadId, agentId, providerAccountId } = parseAgentThreadQueueKey(queueJid);
    const group = await resolveConversationRoute(deps, chatJid, agentId, threadId, providerAccountId);
    if (!group)
        return 'listener_degraded';
    if (!deps.hasChannel(chatJid, { providerAccountId: group.providerAccountId })) {
        logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
        return 'listener_degraded';
    }
    const triggerPattern = getTriggerPattern(group.trigger);
    const loopCmdMsg = groupMessages.find((m) => extractSessionCommand(m.content, triggerPattern) !== null);
    const recoveredCursor = await deps.getOrRecoverCursor(queueJid);
    if (loopCmdMsg) {
        const loopCommand = extractSessionCommand(loopCmdMsg.content, triggerPattern);
        const controlAllowlistCfg = loadSenderControlAllowlist();
        if (isSessionCommandAllowed(loopCmdMsg.is_from_me === true, isSenderControlAllowed(chatJid, loopCmdMsg.sender, controlAllowlistCfg, group.folder))) {
            if (loopCommand && deps.handleActiveControlCommand) {
                const handled = await deps.handleActiveControlCommand({
                    chatJid,
                    queueJid,
                    group,
                    message: loopCmdMsg,
                    command: loopCommand,
                });
                if (handled) {
                    if (preloadedInitialReplay?.hasMore) {
                        return enqueueMessageCheck(deps, queueJid);
                    }
                    return 'completed';
                }
            }
            if (loopCommand?.kind === 'stop') {
                await deps.queue.stopGroup?.(queueJid);
            }
            else {
                await deps.queue.closeStdin(queueJid);
            }
        }
        return enqueueMessageCheck(deps, queueJid);
    }
    const replay = preloadedInitialReplay ??
        (await collectPendingMessagesSince({
            getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
            chatJid,
            sinceCursor: recoveredCursor,
            pageSize: MESSAGE_FETCH_PAGE_SIZE,
            maxMessages: MAX_MESSAGES_PER_PROMPT,
            options: {
                threadId: threadId ?? null,
                ...(group.providerAccountId
                    ? { providerAccountId: group.providerAccountId }
                    : {}),
            },
        }));
    let initialBatch = replay.messages;
    if (initialBatch.length === 0) {
        initialBatch = groupMessages;
    }
    if (replay.responseSchema !== undefined ||
        replay.agentControls !== undefined) {
        await deps.queue.closeStdin(queueJid);
        return enqueueMessageCheck(deps, queueJid);
    }
    const needsTrigger = group.requiresTrigger !== false && !options.trustedTriggerBypass;
    if (needsTrigger) {
        const allowlistCfg = loadSenderAllowlist();
        const hasTrigger = initialBatch.some((m) => triggerPattern.test(m.content.trim()) &&
            (m.is_from_me ||
                isTriggerAllowed(chatJid, m.sender, allowlistCfg, group.folder)));
        const isContinuationThread = threadId !== undefined &&
            recoveredCursor.trim().length > 0 &&
            (await hasTriggerOwnedThreadRoot({
                opsRepository,
                chatJid,
                threadId,
                group,
                triggerPattern,
            }));
        if (!hasTrigger && !isContinuationThread) {
            const lastMessage = initialBatch[initialBatch.length - 1];
            const cursorAfter = replay.cursorAfter
                ? replay.cursorAfter
                : lastMessage
                    ? encodeGroupMessageCursor(toGroupMessageCursor(lastMessage))
                    : null;
            if (cursorAfter) {
                deps.setAgentCursor(queueJid, cursorAfter);
                saveStateBestEffort(deps, chatJid);
            }
            if (replay.hasMore) {
                return enqueueMessageCheck(deps, queueJid);
            }
            return 'completed';
        }
    }
    if (initialBatch.length === 0)
        return 'completed';
    const formatted = formatMessages(initialBatch, TIMEZONE);
    const senderUserIds = resolveNonSelfSenderIds(initialBatch);
    const cursorAfter = encodeGroupMessageCursor(toGroupMessageCursor(initialBatch[initialBatch.length - 1]));
    if (!(await deps.queue.sendMessage(queueJid, formatted, {
        threadId,
        senderUserIds,
        idempotencyKey: buildPendingMessagesContinuationIdempotencyKey({
            queueJid,
            sinceCursor: recoveredCursor,
            cursorAfter,
            messages: initialBatch,
        }),
        cursorAfter,
    }))) {
        return enqueueMessageCheck(deps, queueJid);
    }
    logger.debug({ chatJid, count: initialBatch.length }, 'Piped messages to active agent run');
    deps.setAgentCursor(queueJid, cursorAfter);
    saveStateBestEffort(deps, chatJid);
    if (replay.hasMore) {
        return enqueueMessageCheck(deps, queueJid);
    }
    const typing = group.providerAccountId
        ? deps.setTyping(chatJid, true, {
            providerAccountId: group.providerAccountId,
        })
        : deps.setTyping(chatJid, true);
    typing.catch((err) => logger.warn({ chatJid, err }, 'Failed to set typing indicator'));
    return 'completed';
}
export async function processLiveAdmissionWorkItem(deps, item) {
    const opsRepository = resolveMessageRepository(deps);
    const { chatJid, threadId, agentId, providerAccountId } = parseAgentThreadQueueKey(item.queueJid);
    const parsedAgentId = agentId ? agentIdForFolder(agentId) : null;
    const itemAgentId = item.agentId ? agentIdForFolder(item.agentId) : null;
    if (chatJid !== item.conversationId ||
        (threadId ?? null) !== (item.threadId ?? null) ||
        parsedAgentId !== itemAgentId) {
        logger.warn({
            itemId: item.id,
            queueJid: item.queueJid,
            conversationId: item.conversationId,
            threadId: item.threadId,
        }, 'Live admission work item queue identity mismatch');
        return 'listener_degraded';
    }
    const recoveredCursor = await deps.getOrRecoverCursor(item.queueJid);
    const options = {
        threadId: threadId ?? null,
        ...(providerAccountId ? { providerAccountId } : {}),
    };
    const replay = await collectPendingMessagesSince({
        getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
        chatJid,
        sinceCursor: recoveredCursor,
        pageSize: MESSAGE_FETCH_PAGE_SIZE,
        maxMessages: MAX_MESSAGES_PER_PROMPT,
        options,
    });
    const messages = replay.messages;
    if (messages.length === 0) {
        logger.warn({
            itemId: item.id,
            queueJid: item.queueJid,
            filter: { chatJid, ...options },
        }, 'Live admission work item matched no messages');
        return 'completed';
    }
    return processQueueMessages(deps, item.queueJid, messages, replay, {
        trustedTriggerBypass: item.triggerDecision.source === 'callable_agent_follow_up',
    });
}
export async function recoverPendingMessages(deps) {
    const opsRepository = resolveMessageRepository(deps);
    const routesByChatAgentThread = new Map();
    for (const [routeKey, group] of Object.entries(deps.getConversationRoutes())) {
        const parsed = parseAgentThreadQueueKey(routeKey);
        const routeAgentId = parsed.agentId || agentIdForFolder(group.folder);
        const routeProviderAccountId = parsed.providerAccountId || group.providerAccountId || '';
        const dedupeKey = `${parsed.chatJid}::${parsed.threadId ?? ''}::${routeAgentId}::${routeProviderAccountId}`;
        if (!routesByChatAgentThread.has(dedupeKey) || parsed.agentId) {
            routesByChatAgentThread.set(dedupeKey, [routeKey, group]);
        }
    }
    const dedupedRoutes = Object.fromEntries(routesByChatAgentThread.values());
    const exactRouteThreadsByChat = new Map();
    for (const [routeKey] of Object.entries(dedupedRoutes)) {
        const parsed = parseAgentThreadQueueKey(routeKey);
        if (!parsed.threadId)
            continue;
        const providerAccountKey = parsed.providerAccountId ?? '';
        const exactRouteKey = `${parsed.chatJid}::${providerAccountKey}`;
        const exactThreads = exactRouteThreadsByChat.get(exactRouteKey) ?? new Set();
        exactThreads.add(parsed.threadId);
        exactRouteThreadsByChat.set(exactRouteKey, exactThreads);
    }
    for (const [routeKey, group] of routesByChatAgentThread.values()) {
        const parsedRoute = parseAgentThreadQueueKey(routeKey);
        const { chatJid } = parsedRoute;
        const routeAgentId = parsedRoute.agentId || agentIdForFolder(group.folder);
        const queuedThreads = new Set();
        let pendingCount = 0;
        const threadIds = parsedRoute.threadId
            ? [parsedRoute.threadId]
            : await opsRepository.getMessageThreadIds(chatJid, {
                providerAccountId: group.providerAccountId,
            });
        for (const threadId of threadIds) {
            // Thread-scoped routes own provider threads globally; recovery must match live admission.
            const exactRouteKey = `${chatJid}::${group.providerAccountId ?? ''}`;
            if (!parsedRoute.threadId &&
                threadId &&
                exactRouteThreadsByChat.get(exactRouteKey)?.has(threadId)) {
                continue;
            }
            const selectedRoute = selectConversationRouteEntry(dedupedRoutes, chatJid, routeAgentId, threadId, group.providerAccountId);
            if (selectedRoute?.[0] !== routeKey)
                continue;
            const queueJid = makeAgentThreadQueueKey(chatJid, agentIdForFolder(group.folder), threadId, group.providerAccountId);
            const pending = await collectPendingMessagesSince({
                getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
                chatJid,
                sinceCursor: await deps.getOrRecoverCursor(queueJid),
                pageSize: MESSAGE_FETCH_PAGE_SIZE,
                options: { threadId, providerAccountId: group.providerAccountId },
            });
            if (pending.messages.length > 0) {
                pendingCount += pending.messages.length;
                queuedThreads.add(queueJid);
            }
        }
        if (pendingCount === 0)
            continue;
        logger.info({ group: group.name, pendingCount }, 'Recovery: found unprocessed messages');
        for (const queueJid of queuedThreads) {
            deps.queue.enqueueMessageCheck(queueJid);
        }
    }
}

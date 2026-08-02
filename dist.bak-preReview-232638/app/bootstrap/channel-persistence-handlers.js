import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { normalizeThreadQueueId, parseAgentThreadQueueKey, } from '../../shared/thread-queue-key.js';
async function enqueueAndWait(queue, task, onFull) {
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    const wrapped = async () => {
        try {
            await task();
            resolveCompletion();
        }
        catch (err) {
            rejectCompletion(err);
        }
    };
    const admitted = queue.enqueue(wrapped);
    if (!admitted) {
        onFull();
        await queue.enqueueWhenAvailable(wrapped);
    }
    await completion;
}
export function createChannelPersistenceHandlers({ app, resolved, ops, persistenceQueue, runtimeSettings, }) {
    const chatIsGroup = new Map();
    const routesForChat = (chatJid, threadId, providerAccountId) => {
        const requestedProviderAccountId = providerAccountId?.trim();
        const normalizedThreadId = normalizeThreadQueueId(threadId);
        const wholeConversationRoutes = [];
        const threadRoutes = [];
        for (const entry of Object.entries(app.getConversationRoutes())) {
            const [key, route] = entry;
            const parsed = parseAgentThreadQueueKey(key);
            if (parsed.chatJid !== chatJid)
                continue;
            const routeProviderAccountId = parsed.providerAccountId ??
                (typeof route.providerAccountId === 'string'
                    ? route.providerAccountId.trim() || undefined
                    : undefined);
            if (requestedProviderAccountId &&
                routeProviderAccountId !== requestedProviderAccountId) {
                continue;
            }
            if (parsed.threadId) {
                if (normalizedThreadId && parsed.threadId === normalizedThreadId) {
                    threadRoutes.push(entry);
                }
                continue;
            }
            wholeConversationRoutes.push(entry);
        }
        const byAgent = new Map();
        const candidateRoutes = threadRoutes.length > 0 ? threadRoutes : wholeConversationRoutes;
        for (const [key, route] of candidateRoutes) {
            const parsed = parseAgentThreadQueueKey(key);
            const agentId = route.agentId ?? agentIdForFolder(route.folder);
            if (!byAgent.has(agentId) || parsed.agentId)
                byAgent.set(agentId, [key, route]);
        }
        const routeEntries = [...byAgent.values()];
        if (!requestedProviderAccountId) {
            const accountIds = new Set(routeEntries
                .map(([key, route]) => {
                const parsed = parseAgentThreadQueueKey(key);
                return parsed.providerAccountId ?? route.providerAccountId;
            })
                .filter(Boolean));
            if (accountIds.size > 1)
                return [];
        }
        return routeEntries.map(([, route]) => route);
    };
    const ensureConfiguredConversationRoute = async (chatJid, msg) => {
        const existingGroup = routesForChat(chatJid, msg.thread_id, msg.providerAccountId)[0];
        const isKnownDirect = chatIsGroup.get(chatJid) === false ||
            existingGroup?.conversationKind === 'dm';
        if (!isKnownDirect)
            return Boolean(existingGroup);
        if (!existingGroup && !msg.is_from_me && !msg.is_bot_message) {
            resolved.logger.warn({ chatJid, sender: msg.sender }, 'Dropping direct message without configured conversation binding');
        }
        return Boolean(existingGroup);
    };
    return {
        groupJoinOnboarding: resolved.groupJoinOnboarding,
        ensureMessageRoute: ensureConfiguredConversationRoute,
        onMessage: async (chatJid, msg) => {
            const canRoute = await ensureConfiguredConversationRoute(chatJid, msg);
            if (!canRoute)
                return;
            let routes = routesForChat(chatJid, msg.thread_id, msg.providerAccountId);
            if (!msg.is_from_me && !msg.is_bot_message && routes.length > 0) {
                const cfg = resolved.loadSenderAllowlist();
                routes = routes.filter((route) => {
                    if (!resolved.shouldDropMessage(chatJid, cfg, route.folder) ||
                        resolved.isSenderAllowed(chatJid, msg.sender, cfg, route.folder)) {
                        return true;
                    }
                    if (resolved.shouldLogDenied(chatJid, cfg)) {
                        resolved.logger.debug({ chatJid, sender: msg.sender, agentFolder: route.folder }, 'sender-allowlist: dropping message (drop mode)');
                    }
                    return false;
                });
                if (routes.length === 0) {
                    return;
                }
            }
            const persistMessage = async () => {
                try {
                    const repository = ops();
                    const shouldEnqueueLiveAdmission = routes.length > 0 && !msg.is_from_me && !msg.is_bot_message;
                    let stored = false;
                    if (shouldEnqueueLiveAdmission &&
                        repository.storeMessageWithLiveAdmission) {
                        for (const route of routes) {
                            await repository.storeMessageWithLiveAdmission(msg, {
                                appId: resolved.appId,
                                agentId: route.agentId ?? agentIdForFolder(route.folder),
                                providerAccountId: route.providerAccountId,
                                triggerDecision: {
                                    source: 'channel_persistence',
                                    requiresTrigger: route.requiresTrigger !== false,
                                    conversationKind: route.conversationKind ?? null,
                                },
                            });
                        }
                        stored = true;
                    }
                    else {
                        await repository.storeMessage(msg);
                        stored = true;
                    }
                    if (stored && !msg.is_from_me && !msg.is_bot_message) {
                        // Awaited inside the persistence queue so same-thread harvest
                        // read-modify-writes stay serialized; failures only warn and
                        // never break message persistence.
                        await resolved.brainHarvestTap
                            ?.harvest({
                            appId: resolved.appId,
                            message: msg,
                            settings: runtimeSettings(),
                        })
                            .catch((err) => resolved.logger.warn({ err, chatJid }, 'Brain channel harvest failed'));
                    }
                }
                catch (err) {
                    resolved.logger.error({ err, chatJid }, 'Failed to store message');
                    throw err;
                }
            };
            await enqueueAndWait(persistenceQueue, persistMessage, () => resolved.logger.warn({ chatJid, queueSize: persistenceQueue.size() }, 'Persistence queue full; waiting to enqueue message persistence'));
        },
        onChatMetadata: async (chatJid, timestamp, name, channel, isGroup, options) => {
            if (isGroup !== undefined)
                chatIsGroup.set(chatJid, Boolean(isGroup));
            const persistMetadata = async () => {
                try {
                    await ops().storeChatMetadata(chatJid, timestamp, name, channel, isGroup, options);
                }
                catch (err) {
                    resolved.logger.error({ err, chatJid }, 'Failed to store chat metadata');
                    throw err;
                }
            };
            await enqueueAndWait(persistenceQueue, persistMetadata, () => resolved.logger.warn({ chatJid, queueSize: persistenceQueue.size() }, 'Persistence queue full; waiting to enqueue chat metadata persistence'));
        },
    };
}

const THREAD_QUEUE_MARKER = '::thread:';
const AGENT_QUEUE_MARKER = '::agent:';
const PROVIDER_ACCOUNT_QUEUE_MARKER = '::provider_account:';
export function normalizeThreadQueueId(threadId) {
    const normalized = threadId?.trim();
    return normalized || undefined;
}
export function makeThreadQueueKey(chatJid, threadId) {
    const normalized = normalizeThreadQueueId(threadId);
    if (!normalized)
        return chatJid;
    return `${chatJid}${THREAD_QUEUE_MARKER}${encodeURIComponent(normalized)}`;
}
export function makeAgentThreadQueueKey(chatJid, agentId, threadId, providerAccountId) {
    const base = makeThreadQueueKey(chatJid, threadId);
    const normalizedAgentId = agentId?.trim();
    const normalizedProviderAccountId = providerAccountId?.trim();
    const agentKey = normalizedAgentId
        ? `${base}${AGENT_QUEUE_MARKER}${encodeURIComponent(normalizedAgentId)}`
        : base;
    if (!normalizedProviderAccountId)
        return agentKey;
    return `${agentKey}${PROVIDER_ACCOUNT_QUEUE_MARKER}${encodeURIComponent(normalizedProviderAccountId)}`;
}
export function parseThreadQueueKey(queueJid) {
    const providerMarkerIndex = queueJid.lastIndexOf(PROVIDER_ACCOUNT_QUEUE_MARKER);
    const routeQueueJid = providerMarkerIndex < 0 ? queueJid : queueJid.slice(0, providerMarkerIndex);
    const agentMarkerIndex = routeQueueJid.lastIndexOf(AGENT_QUEUE_MARKER);
    const threadQueueJid = agentMarkerIndex < 0
        ? routeQueueJid
        : routeQueueJid.slice(0, agentMarkerIndex);
    const markerIndex = threadQueueJid.lastIndexOf(THREAD_QUEUE_MARKER);
    if (markerIndex < 0)
        return { chatJid: threadQueueJid };
    const chatJid = threadQueueJid.slice(0, markerIndex);
    const encodedThreadId = threadQueueJid.slice(markerIndex + THREAD_QUEUE_MARKER.length);
    if (!chatJid || !encodedThreadId)
        return { chatJid: threadQueueJid };
    try {
        return {
            chatJid,
            threadId: normalizeThreadQueueId(decodeURIComponent(encodedThreadId)),
        };
    }
    catch {
        return { chatJid: threadQueueJid };
    }
}
export function parseAgentThreadQueueKey(queueJid) {
    const providerMarkerIndex = queueJid.lastIndexOf(PROVIDER_ACCOUNT_QUEUE_MARKER);
    const providerSuffix = providerMarkerIndex < 0
        ? undefined
        : queueJid.slice(providerMarkerIndex + PROVIDER_ACCOUNT_QUEUE_MARKER.length);
    const routeQueueJid = providerMarkerIndex < 0 ? queueJid : queueJid.slice(0, providerMarkerIndex);
    const agentMarkerIndex = routeQueueJid.lastIndexOf(AGENT_QUEUE_MARKER);
    const parsed = parseThreadQueueKey(queueJid);
    let providerAccountId;
    if (providerSuffix) {
        try {
            providerAccountId =
                decodeURIComponent(providerSuffix).trim() || undefined;
        }
        catch {
            providerAccountId = undefined;
        }
    }
    if (agentMarkerIndex < 0) {
        return providerAccountId ? { ...parsed, providerAccountId } : parsed;
    }
    const encodedAgentId = routeQueueJid.slice(agentMarkerIndex + AGENT_QUEUE_MARKER.length);
    if (!encodedAgentId)
        return parsed;
    try {
        const agentId = decodeURIComponent(encodedAgentId).trim();
        const withProvider = providerAccountId ? { providerAccountId } : {};
        return agentId ? { ...parsed, agentId, ...withProvider } : parsed;
    }
    catch {
        return parsed;
    }
}
export function findConversationRoutesForChat(routes, chatJid, threadId, providerAccountId) {
    const normalizedThreadId = normalizeThreadQueueId(threadId);
    const normalizedProviderAccountId = providerAccountId?.trim();
    const wholeConversationRoutes = [];
    const threadRoutes = [];
    for (const entry of Object.entries(routes)) {
        const parsed = parseAgentThreadQueueKey(entry[0]);
        if (parsed.chatJid !== chatJid)
            continue;
        const routeProviderAccountId = parsed.providerAccountId ??
            (typeof entry[1]
                .providerAccountId === 'string'
                ? entry[1].providerAccountId.trim()
                : undefined);
        if (normalizedProviderAccountId &&
            routeProviderAccountId !== normalizedProviderAccountId) {
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
    return threadRoutes.length > 0 ? threadRoutes : wholeConversationRoutes;
}
export function findSingleConversationRouteForChat(routes, chatJid, threadId) {
    const matches = findConversationRoutesForChat(routes, chatJid, threadId);
    return matches.length === 1 ? matches[0]?.[1] : undefined;
}
export function routesForConversationId(routes, conversationId) {
    if (!conversationId)
        return {};
    return Object.fromEntries(Object.entries(routes).filter(([, route]) => route.conversationId === conversationId));
}
export function findConversationRouteForQueue(routes, queueJid, agentIdForRoute) {
    const queue = parseAgentThreadQueueKey(queueJid);
    const queueThreadId = normalizeThreadQueueId(queue.threadId);
    const queueAgentId = queue.agentId?.trim();
    const queueProviderAccountId = queue.providerAccountId?.trim();
    if (queueThreadId &&
        queueAgentId &&
        queueProviderAccountId &&
        Object.hasOwn(routes, queueJid)) {
        return routes[queueJid];
    }
    if (queueAgentId && queueProviderAccountId) {
        const wholeConversationKey = makeAgentThreadQueueKey(queue.chatJid, queueAgentId, undefined, queueProviderAccountId);
        if (Object.hasOwn(routes, wholeConversationKey)) {
            return routes[wholeConversationKey];
        }
    }
    const candidates = [];
    for (const [key, route] of Object.entries(routes)) {
        const parsed = parseAgentThreadQueueKey(key);
        if (parsed.chatJid !== queue.chatJid)
            continue;
        const routeProviderAccountId = parsed.providerAccountId ??
            (typeof route.providerAccountId ===
                'string'
                ? route.providerAccountId.trim() ||
                    undefined
                : undefined);
        if (queueProviderAccountId &&
            routeProviderAccountId !== queueProviderAccountId)
            continue;
        const routeAgentId = parsed.agentId ?? agentIdForRoute(route);
        if (queueAgentId && routeAgentId !== queueAgentId)
            continue;
        candidates.push({
            route,
            routeThreadId: parsed.threadId,
            routeAgentId,
            routeConversationId: typeof route.conversationId ===
                'string'
                ? route.conversationId.trim() ||
                    undefined
                : undefined,
            routeProviderAccountId,
            routeKeyHasAgent: Boolean(parsed.agentId),
        });
    }
    const exactThreadRoutes = queueThreadId
        ? candidates.filter((candidate) => candidate.routeThreadId === queueThreadId)
        : [];
    const wholeConversationRoutes = candidates.filter((candidate) => !candidate.routeThreadId);
    const matches = queueThreadId && exactThreadRoutes.length > 0
        ? exactThreadRoutes
        : wholeConversationRoutes;
    if (queueAgentId) {
        const routeIdentities = new Set(matches.map((candidate) => `${candidate.routeConversationId ?? ''}::${candidate.routeProviderAccountId ?? ''}`));
        if (routeIdentities.size > 1)
            return undefined;
        return (matches.find((candidate) => candidate.routeKeyHasAgent)?.route ??
            matches[0]?.route);
    }
    const routeIdentities = new Set(matches.map((candidate) => `${candidate.routeAgentId}::${candidate.routeThreadId ?? ''}::${candidate.routeConversationId ?? ''}::${candidate.routeProviderAccountId ?? ''}`));
    if (routeIdentities.size === 1) {
        return (matches.find((candidate) => candidate.routeKeyHasAgent)?.route ??
            matches[0]?.route);
    }
    return matches.length === 1 ? matches[0]?.route : undefined;
}
export function firstThreadQueueId(...threadIds) {
    for (const threadId of threadIds) {
        const normalized = normalizeThreadQueueId(threadId);
        if (normalized)
            return normalized;
    }
    return undefined;
}

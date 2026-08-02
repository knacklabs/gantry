import { AppMemoryService } from './app-memory-service.js';
import { memoryScopeForConversationKind, resolveScopedMemorySubject, searchInputForResolvedMemorySubject, } from './app-memory-subject-resolver.js';
import { conversationJidFromSession, parseSessionScopeKey, } from './app-memory-session-scope.js';
const FIRST_VISIBLE_STATEMENT_TIMEOUT_MS = 250;
function directUserCandidates(session) {
    const sessionScope = parseSessionScopeKey({ session });
    const sessionUserId = session.userId?.trim();
    if (sessionUserId && !sessionScope.isScopeKey)
        return [sessionUserId];
    return [];
}
function resolveSessionHydrationScopes(input) {
    const { session, conversationKind } = input;
    const scope = parseSessionScopeKey({ session });
    const defaultScope = input.defaultScope ?? memoryScopeForConversationKind(conversationKind);
    const userCandidates = directUserCandidates(session);
    const userId = userCandidates[0];
    const conversationId = conversationJidFromSession(session);
    if (defaultScope === 'user' && !userId)
        return [];
    if (defaultScope !== 'user' && !conversationId)
        return [];
    try {
        const { subject } = resolveScopedMemorySubject({
            appId: session.appId,
            agentId: session.agentId,
            groupId: scope.groupId ?? session.agentId,
            conversationId,
            userId,
            defaultScope,
        });
        return [searchInputForResolvedMemorySubject(subject)];
    }
    catch {
        return [];
    }
}
async function loadScopedMemoryRows(memoryService, scope, input) {
    const rows = [];
    const seenIds = new Set();
    const pushRows = (items) => {
        for (const item of items) {
            if (!itemMatchesHydrationScope(item, scope))
                continue;
            if (seenIds.has(item.id))
                continue;
            seenIds.add(item.id);
            rows.push(item);
            if (rows.length >= input.limit)
                break;
        }
    };
    const query = input.query?.trim();
    const readOptions = hydrationReadOptions(input);
    if (query) {
        const searchInput = {
            ...scope,
            query,
            limit: input.limit,
        };
        const searchRows = readOptions
            ? await memoryService.searchForHydrationReadOnly(searchInput, {
                ...readOptions,
                ...(input.hydrationMode === 'first_visible'
                    ? { allowEmbeddings: false }
                    : {}),
            })
            : await memoryService.searchForHydrationReadOnly(searchInput);
        pushRows(searchRows.map((result) => result.item));
    }
    if (rows.length < input.limit) {
        const listInput = {
            ...scope,
            limit: input.limit,
        };
        const listRows = readOptions
            ? await memoryService.listForHydrationReadOnly(listInput, readOptions)
            : await memoryService.listForHydrationReadOnly(listInput);
        pushRows(listRows);
    }
    return rows;
}
function hydrationReadOptions(input) {
    const statementTimeoutMs = input.statementTimeoutMs ??
        (input.hydrationMode === 'first_visible'
            ? FIRST_VISIBLE_STATEMENT_TIMEOUT_MS
            : undefined);
    return statementTimeoutMs ? { statementTimeoutMs } : undefined;
}
function itemMatchesHydrationScope(item, scope) {
    const subjectType = scope.subjectTypes?.[0];
    if (subjectType && item.subjectType !== subjectType)
        return false;
    if (scope.userId && item.userId !== scope.userId)
        return false;
    if (scope.groupId && item.groupId !== scope.groupId)
        return false;
    if (scope.channelId && item.channelId !== scope.channelId)
        return false;
    return true;
}
export async function loadSessionAppMemoryItems(input) {
    const memoryService = AppMemoryService.getInstance();
    const scopes = resolveSessionHydrationScopes(input);
    const rows = [];
    const seenIds = new Set();
    for (const scope of scopes) {
        if (rows.length >= input.limit)
            break;
        const nextRows = await loadScopedMemoryRows(memoryService, scope, {
            limit: Math.max(1, input.limit - rows.length),
            query: input.query,
            hydrationMode: input.hydrationMode,
            statementTimeoutMs: input.statementTimeoutMs,
        });
        for (const row of nextRows) {
            if (seenIds.has(row.id))
                continue;
            seenIds.add(row.id);
            rows.push(row);
            if (rows.length >= input.limit)
                break;
        }
    }
    return rows.map((item) => ({
        id: item.id,
        kind: item.kind,
        key: item.key,
        value: item.value,
        subject: {
            subjectType: item.subjectType,
            subjectId: item.subjectId,
            ...(item.userId ? { userId: item.userId } : {}),
            ...(item.groupId ? { groupId: item.groupId } : {}),
            ...(item.channelId ? { channelId: item.channelId } : {}),
        },
    }));
}
export async function loadBoundaryExtractionAppMemoryItems(input) {
    const memoryService = AppMemoryService.getInstance();
    const scopes = resolveSessionHydrationScopes({
        session: input.session,
        defaultScope: input.defaultScope ?? 'group',
    });
    const rows = [];
    const seenIds = new Set();
    for (const scope of scopes) {
        if (rows.length >= input.limit)
            break;
        const nextRows = await loadScopedMemoryRows(memoryService, scope, {
            limit: Math.max(1, input.limit - rows.length),
        });
        for (const row of nextRows) {
            if (seenIds.has(row.id))
                continue;
            seenIds.add(row.id);
            rows.push(row);
            if (rows.length >= input.limit)
                break;
        }
    }
    return rows.map((item) => ({
        id: item.id,
        key: item.key,
        value: item.value,
    }));
}

import { DEFAULT_MEMORY_APP_ID, memoryAgentIdForWorkspaceFolder, } from '../memory/app-memory-boundaries.js';
import { resolveScopedMemorySubject, searchInputForResolvedMemorySubject, } from '../memory/app-memory-subject-resolver.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import { getEmbeddingBackfillStatus } from '../memory/app-memory-embedding-status.js';
function parseJsonObject(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function parseRetrievalCount(value) {
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0)
        return 0;
    return Math.trunc(numeric);
}
function retrievalCountFromMemoryMetadata(item) {
    const extended = item;
    const sourceRefJson = parseJsonObject(extended.sourceRefJson);
    return parseRetrievalCount(extended.retrievalCount ??
        extended.retrieval_count ??
        extended.metadata?.retrievalCount ??
        extended.metadata?.retrieval_count ??
        extended.sourceRef?.retrievalCount ??
        sourceRefJson.retrievalCount);
}
function compareUpdatedAtAsc(a, b) {
    const timeDiff = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    if (timeDiff !== 0)
        return timeDiff;
    return a.key.localeCompare(b.key);
}
function parseCount(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : undefined;
}
function parseInjectedBlock(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    const subject = parseOptionalText(record.subject);
    const at = parseOptionalText(record.at);
    const bytes = parseCount(record.bytes);
    if (!subject && bytes === undefined && !at)
        return undefined;
    return {
        ...(subject ? { subject } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
        ...(at ? { at } : {}),
    };
}
function parseOptionalText(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
function parseDreamRun(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    const at = parseOptionalText(record.at);
    const startedAt = parseOptionalText(record.startedAt);
    const completedAt = record.completedAt === null ? null : parseOptionalText(record.completedAt);
    if (!at &&
        !startedAt &&
        completedAt === undefined &&
        record.summary === undefined) {
        return undefined;
    }
    return {
        ...(at ? { at } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
    };
}
function dreamRunTimestamp(run) {
    return run.completedAt || run.at || run.startedAt;
}
async function getContinuityStatusData(service, input) {
    const candidate = service;
    return typeof candidate.continuityStatus === 'function'
        ? candidate.continuityStatus(input)
        : undefined;
}
async function safeEmbeddingStatus(service, subject) {
    try {
        return await getEmbeddingBackfillStatus(service.db, {
            appId: subject.appId,
            agentId: subject.agentId,
        });
    }
    catch {
        return undefined;
    }
}
export async function getGroupMemoryStatus(input, options = {}) {
    const service = AppMemoryService.getInstance();
    const context = typeof input === 'string'
        ? { folder: input }
        : {
            ...input,
            ...(input.threadId ? { threadId: input.threadId } : {}),
        };
    const subject = resolveScopedMemorySubject({
        appId: DEFAULT_MEMORY_APP_ID,
        agentId: memoryAgentIdForWorkspaceFolder(context.folder),
        groupId: context.folder,
        conversationId: context.conversationId,
        userId: context.userId,
        threadId: context.threadId || undefined,
        defaultScope: context.defaultScope,
    }).subject;
    const memories = await service.list({
        ...searchInputForResolvedMemorySubject(subject),
        limit: 100,
    });
    const continuityStatus = await getContinuityStatusData(service, {
        ...subject,
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
    });
    const runs = continuityStatus
        ? []
        : await service.dreamingStatus({
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
        });
    const latestDreamRun = parseDreamRun(continuityStatus?.lastDreamRun ?? continuityStatus?.last_dream_run) ?? runs[0];
    const lastRunSummary = latestDreamRun &&
        typeof latestDreamRun.summary === 'object' &&
        latestDreamRun.summary
        ? latestDreamRun.summary
        : {};
    const stagedCount = parseCount(continuityStatus?.stagedCount) ??
        parseCount(continuityStatus?.staged_count) ??
        parseCount(lastRunSummary.staged) ??
        parseCount(lastRunSummary.stageCandidate) ??
        0;
    const promotedCount = parseCount(continuityStatus?.promotedCount) ??
        parseCount(continuityStatus?.promoted_count) ??
        parseCount(lastRunSummary.promoted) ??
        0;
    const needsReviewCount = parseCount(continuityStatus?.needsReviewCount) ??
        parseCount(continuityStatus?.needs_review_count) ??
        parseCount(lastRunSummary.needsReview) ??
        0;
    const topUsed = memories
        .map((item) => ({
        key: item.key,
        retrieval_count: retrievalCountFromMemoryMetadata(item),
        updatedAt: item.updatedAt,
    }))
        .sort((a, b) => {
        const countDiff = b.retrieval_count - a.retrieval_count;
        if (countDiff !== 0)
            return countDiff;
        const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        if (timeDiff !== 0)
            return timeDiff;
        return a.key.localeCompare(b.key);
    })
        .slice(0, 10)
        .map(({ key, retrieval_count }) => ({ key, retrieval_count }));
    const lastInjectedBlock = parseInjectedBlock(continuityStatus?.lastInjectedBlock ??
        continuityStatus?.last_injected_block);
    const embeddingStatus = await safeEmbeddingStatus(service, subject);
    return {
        memory_enabled: options.memoryEnabled ?? true,
        items_by_kind: memories.reduce((acc, item) => {
            acc[item.kind] = (acc[item.kind] || 0) + 1;
            return acc;
        }, {}),
        items_by_scope: memories.reduce((acc, item) => {
            acc[item.subjectType] = (acc[item.subjectType] || 0) + 1;
            return acc;
        }, {}),
        top10_most_used: topUsed,
        top10_stalest: [...memories]
            .sort(compareUpdatedAtAsc)
            .slice(0, 10)
            .map((item) => ({
            key: item.key,
            updated_at: item.updatedAt,
        })),
        retrieval: {
            searchMode: embeddingStatus?.searchMode ?? 'lexical_keyword',
            embeddings: embeddingStatus
                ? embeddingStatus.enabled
                    ? 'configured'
                    : 'disabled'
                : (options.embeddings ?? 'disabled'),
            vectorSearch: embeddingStatus?.vectorSearch ?? 'inactive',
            ...(embeddingStatus?.pauseReason
                ? { pauseReason: embeddingStatus.pauseReason }
                : {}),
            ...(embeddingStatus
                ? {
                    ready: embeddingStatus.readyItems,
                    pending: embeddingStatus.pending,
                }
                : {}),
        },
        memory_pipeline: {
            staged: stagedCount,
            promoted: promotedCount,
            needs_review: needsReviewCount,
        },
        ...(lastInjectedBlock ? { last_injected_block: lastInjectedBlock } : {}),
        last_dream_run: latestDreamRun
            ? {
                at: dreamRunTimestamp(latestDreamRun),
                summary: JSON.stringify(latestDreamRun.summary),
            }
            : undefined,
    };
}
export async function saveGroupProcedureMemory(input) {
    const { subject } = resolveScopedMemorySubject({
        appId: DEFAULT_MEMORY_APP_ID,
        agentId: memoryAgentIdForWorkspaceFolder(input.folder),
        groupId: input.folder,
        conversationId: input.conversationId,
        userId: input.userId,
        threadId: input.threadId || undefined,
        defaultScope: input.defaultScope,
    });
    return AppMemoryService.getInstance().save({
        ...subject,
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        kind: 'reference',
        key: `procedure:${input.title}`,
        value: input.body,
        source: 'explicit',
        confidence: 0.8,
        evidenceText: input.body,
        actorId: 'agent',
        isAdminWrite: input.isAdminWrite,
    });
}

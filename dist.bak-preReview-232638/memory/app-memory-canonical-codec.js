import { createHash } from 'node:crypto';
import { normalizeSubject } from './app-memory-boundaries.js';
export function hashText(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function parseJsonObject(value) {
    if (!value)
        return {};
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string')
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
export function parseItemValue(row) {
    const payload = parseJsonObject(row.valueJson);
    return {
        value: typeof payload.value === 'string' ? payload.value : '',
        why: typeof payload.why === 'string' ? payload.why : null,
    };
}
export function parseItemSource(row) {
    const payload = parseJsonObject(row.sourceRefJson);
    const subjectPayload = parseJsonObject(JSON.stringify(payload.subject ?? {}));
    return {
        subject: normalizeSubject({
            appId: row.appId,
            agentId: typeof subjectPayload.agentId === 'string'
                ? subjectPayload.agentId
                : row.agentId || undefined,
            subjectType: typeof subjectPayload.subjectType === 'string'
                ? subjectPayload.subjectType
                : undefined,
            subjectId: typeof subjectPayload.subjectId === 'string'
                ? subjectPayload.subjectId
                : row.subjectId,
            userId: typeof subjectPayload.userId === 'string'
                ? subjectPayload.userId
                : undefined,
            groupId: typeof subjectPayload.groupId === 'string'
                ? subjectPayload.groupId
                : undefined,
            channelId: typeof subjectPayload.channelId === 'string'
                ? subjectPayload.channelId
                : undefined,
        }),
        source: typeof payload.source === 'string' ? payload.source : 'sdk',
        evidenceIds: Array.isArray(payload.evidenceIds)
            ? payload.evidenceIds.filter((entry) => typeof entry === 'string')
            : [],
        isPinned: Boolean(payload.isPinned),
        version: typeof payload.version === 'number' && Number.isFinite(payload.version)
            ? payload.version
            : 1,
        retrievalCount: typeof payload.retrievalCount === 'number' &&
            Number.isFinite(payload.retrievalCount)
            ? payload.retrievalCount
            : undefined,
        totalScore: typeof payload.totalScore === 'number' &&
            Number.isFinite(payload.totalScore)
            ? payload.totalScore
            : undefined,
        maxScore: typeof payload.maxScore === 'number' && Number.isFinite(payload.maxScore)
            ? payload.maxScore
            : undefined,
    };
}
export function encodeItemSource(input) {
    return {
        subject: input.subject,
        source: input.source,
        evidenceIds: input.evidenceIds,
        isPinned: input.isPinned,
        version: input.version,
        retrievalCount: input.retrievalCount ?? 0,
        totalScore: input.totalScore ?? 0,
        maxScore: input.maxScore ?? 0,
    };
}
export function clampConfidence(value, fallback = 0.7) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.min(1, value));
}
export function normalizeKind(value) {
    const allowed = new Set([
        'preference',
        'decision',
        'fact',
        'correction',
        'constraint',
        'reference',
    ]);
    return allowed.has(value) ? value : 'fact';
}
export function toAppItem(row) {
    const value = parseItemValue(row);
    const source = parseItemSource(row);
    const subject = source.subject;
    return {
        id: row.id,
        appId: row.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        ...(subject.userId ? { userId: subject.userId } : {}),
        ...(subject.groupId ? { groupId: subject.groupId } : {}),
        ...(subject.channelId ? { channelId: subject.channelId } : {}),
        kind: row.kind,
        key: row.key,
        value: value.value,
        why: value.why,
        confidence: row.confidence,
        isPinned: source.isPinned,
        version: source.version,
        source: source.source,
        evidenceIds: source.evidenceIds,
        ...(source.retrievalCount !== undefined
            ? { retrievalCount: source.retrievalCount }
            : {}),
        ...(source.totalScore !== undefined
            ? { totalScore: source.totalScore }
            : {}),
        ...(source.maxScore !== undefined ? { maxScore: source.maxScore } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
export function itemMatchesSubjectBoundary(row, context) {
    const subject = parseItemSource(row).subject;
    if (row.appId !== context.appId)
        return false;
    if (subject.agentId !== context.agentId)
        return false;
    if (subject.subjectType !== context.subjectType)
        return false;
    if (subject.subjectId !== context.subjectId)
        return false;
    return true;
}

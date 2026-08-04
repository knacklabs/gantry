import { parseJsonObject } from './app-memory-canonical-codec.js';
export function conversationIdForChannel(channelId) {
    if (!channelId)
        return null;
    return channelId.startsWith('conversation:')
        ? channelId
        : `conversation:${channelId}`;
}
export function toEvidence(row) {
    return {
        id: row.id,
        appId: row.appId,
        agentId: row.agentId,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        ...(row.userId ? { userId: row.userId } : {}),
        ...(row.groupId ? { groupId: row.groupId } : {}),
        ...(row.channelId ? { channelId: row.channelId } : {}),
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        actorId: row.actorId,
        text: row.text,
        metadata: parseJsonObject(row.metadataJson),
        createdAt: row.createdAt,
    };
}
export function toRun(row) {
    return {
        runId: row.id,
        appId: row.appId,
        agentId: row.agentId,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        phase: row.phase,
        status: row.status,
        summary: parseJsonObject(row.summaryJson),
        startedAt: row.startedAt,
        completedAt: row.completedAt,
    };
}

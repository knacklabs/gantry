import { parseJsonObject } from './app-memory-canonical-codec.js';
function parseJsonStringRecord(value) {
    const parsed = parseJsonObject(value);
    return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === 'string'));
}
function parseJsonNumberRecord(value) {
    const parsed = parseJsonObject(value);
    return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}
function parseReviewProposal(value) {
    const parsed = parseJsonObject(value);
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    return {
        action: action,
        ...(typeof parsed.candidateId === 'string'
            ? { candidateId: parsed.candidateId }
            : {}),
        ...(typeof parsed.itemId === 'string' ? { itemId: parsed.itemId } : {}),
        ...(Array.isArray(parsed.itemIds)
            ? {
                itemIds: parsed.itemIds.filter((entry) => typeof entry === 'string'),
            }
            : {}),
        ...(typeof parsed.targetItemId === 'string'
            ? { targetItemId: parsed.targetItemId }
            : {}),
        ...(typeof parsed.kind === 'string'
            ? { kind: parsed.kind }
            : {}),
        ...(typeof parsed.key === 'string' ? { key: parsed.key } : {}),
        ...(typeof parsed.value === 'string' ? { value: parsed.value } : {}),
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        confidence: typeof parsed.confidence === 'number' &&
            Number.isFinite(parsed.confidence)
            ? parsed.confidence
            : 0,
        evidenceIds: Array.isArray(parsed.evidenceIds)
            ? parsed.evidenceIds.filter((entry) => typeof entry === 'string')
            : [],
    };
}
export function toMemoryReview(row) {
    return {
        id: row.id,
        runId: row.runId,
        appId: row.appId,
        agentId: row.agentId,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        phase: row.phase,
        proposal: parseReviewProposal(row.proposalJson),
        status: row.status,
        itemVersions: parseJsonNumberRecord(row.itemVersionsJson),
        candidateVersions: parseJsonStringRecord(row.candidateVersionsJson),
        validationSummary: row.validationSummary,
        reviewerId: row.reviewerId,
        decision: row.decision,
        editedValue: row.editedValue,
        editedReason: row.editedReason,
        applyOutcome: row.applyOutcome,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        decidedAt: row.decidedAt,
    };
}

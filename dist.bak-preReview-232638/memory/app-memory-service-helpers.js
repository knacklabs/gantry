import { hashText } from './app-memory-canonical-codec.js';
import { subjectIdFor } from './app-memory-boundaries.js';
import { clampConfidence, encodeItemSource, normalizeKind, } from './app-memory-canonical-codec.js';
import { conversationIdForChannel } from './app-memory-service-record-mappers.js';
export function memoryContentHash(input) {
    return hashText(`${input.appId}:${input.agentId}:${input.subjectType}:${input.subjectId}:${input.key}:${input.value}`);
}
/**
 * Canonical text that is embedded for a memory item. The content hash is taken
 * over exactly this string so that any change to key/value/why re-embeds the
 * item (and only that item). Dreaming and backfill share this so a single ready
 * vector represents the item's current text.
 */
export function embeddingTextForMemory(input) {
    return `${input.key}\n${input.value}\n${input.why ?? ''}`;
}
export function embeddingContentHash(input) {
    return hashText(embeddingTextForMemory(input));
}
export function isUniqueViolation(err) {
    if (err !== null && typeof err === 'object') {
        if ('code' in err && err.code === '23505') {
            return true;
        }
        if ('cause' in err) {
            return isUniqueViolation(err.cause);
        }
    }
    return false;
}
export function buildMemoryItemWriteBase(input) {
    const nextEvidenceIds = Array.from(new Set([
        ...(input.existingSource?.evidenceIds ?? []),
        ...input.evidenceIds,
    ]));
    const nextVersion = input.existingSource
        ? input.existingSource.version + 1
        : 1;
    const sourceRef = encodeItemSource({
        subject: input.subject,
        source: input.saveInput.source || 'sdk',
        evidenceIds: nextEvidenceIds,
        isPinned: input.existingSource?.isPinned ?? false,
        version: nextVersion,
        retrievalCount: input.existingSource?.retrievalCount,
        totalScore: input.existingSource?.totalScore,
        maxScore: input.existingSource?.maxScore,
    });
    if (input.saveInput.dreamingPromotion) {
        sourceRef.promoted_by = 'dreaming';
        sourceRef.promoted_at = input.saveInput.dreamingPromotion.promotedAt;
        sourceRef.dream_run_id = input.saveInput.dreamingPromotion.runId;
        if (input.saveInput.dreamingPromotion.candidateId) {
            sourceRef.dream_candidate_id =
                input.saveInput.dreamingPromotion.candidateId;
        }
    }
    return {
        appId: input.subject.appId,
        agentId: input.subject.agentId,
        subjectType: input.subject.subjectType,
        subjectId: subjectIdFor(input.subject),
        userId: input.subject.userId ?? null,
        conversationId: conversationIdForChannel(input.subject.channelId),
        threadId: null,
        kind: normalizeKind(input.saveInput.kind),
        key: input.key,
        valueJson: {
            value: input.value,
            why: input.saveInput.why?.trim() || null,
            contentHash: memoryContentHash({
                appId: input.subject.appId,
                agentId: input.subject.agentId,
                subjectType: input.subject.subjectType,
                subjectId: input.subject.subjectId,
                key: input.key,
                value: input.value,
            }),
        },
        sourceRefJson: sourceRef,
        confidence: clampConfidence(input.saveInput.confidence),
        status: 'active',
        lastObservedAt: input.timestamp,
        updatedAt: input.timestamp,
    };
}

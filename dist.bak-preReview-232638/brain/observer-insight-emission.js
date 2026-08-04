import { createHash, randomUUID } from 'node:crypto';
import { OBSERVER_INSIGHT_TYPES } from '../domain/ports/observer-insights.js';
import { loadCanonicalActiveMemoryValues, } from '../memory/observer-active-memory.js';
import { isUniqueViolation } from '../memory/app-memory-service-helpers.js';
import { embeddingCacheTextHash } from '../memory/memory-embedding-cache.js';
import { canonicalConversationIdForPattern } from '../shared/pattern-candidate-subject.js';
import { canonicalizeObserverInsightText, cosineSimilarity, evaluateObserverInsightFloor, OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD, } from '../shared/observer-insight-policy.js';
import { nowIso } from '../shared/time/datetime.js';
export const OBSERVER_APP_SUBJECT = 'observer:app';
export const OBSERVER_CURSOR_SUBJECT = 'observer:app';
export const OBSERVER_EMBEDDINGS_UNAVAILABLE_MESSAGE = 'Insight emission paused: embeddings unavailable.';
const LLM_INSIGHT_TYPES = new Set(OBSERVER_INSIGHT_TYPES.filter((type) => type !== 'repetition'));
export function normalizeSurfaceableInsightDraft(value, evidencePageId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    const insightType = row.insightType;
    const title = stringValue(row.title);
    const summary = stringValue(row.summary);
    const canonicalSignature = stringValue(row.canonicalSignature);
    const confidence = row.confidence;
    const evidencePageIds = Array.isArray(row.evidencePageIds) &&
        row.evidencePageIds.some((id) => id === evidencePageId)
        ? [evidencePageId]
        : [];
    if (!LLM_INSIGHT_TYPES.has(insightType) ||
        !title ||
        !summary ||
        !canonicalSignature ||
        typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1) {
        return null;
    }
    return {
        insightType: insightType,
        title,
        summary,
        canonicalSignature,
        confidence,
        evidencePageIds,
    };
}
/**
 * Channel pages encode `${providerAccountId}:${chat_jid}#${discriminator}`
 * (see brain-channel-harvest.ts). The provider account is the first segment;
 * the chat_jid can itself contain colons (e.g. `<provider>:C123`). The account is
 * load-bearing: conversation ids are only unique per provider account.
 */
export function parseChannelSourceRef(sourceRef) {
    if (!sourceRef)
        return null;
    const hashIndex = sourceRef.indexOf('#');
    const base = hashIndex >= 0 ? sourceRef.slice(0, hashIndex) : sourceRef;
    const discriminator = hashIndex >= 0 ? sourceRef.slice(hashIndex + 1) : '';
    const separator = base.indexOf(':');
    if (separator < 0)
        return null;
    const providerAccountId = base.slice(0, separator).trim();
    const conversationJid = base.slice(separator + 1).trim();
    if (!providerAccountId || !conversationJid)
        return null;
    return {
        providerAccountId,
        conversationJid,
        discriminator: discriminator.trim(),
    };
}
export function observerSubjectForPage(page) {
    if (page.sourceKind !== 'channel')
        return OBSERVER_APP_SUBJECT;
    const parsed = parseChannelSourceRef(page.sourceRef);
    return parsed
        ? `conversation:${parsed.conversationJid}`
        : OBSERVER_APP_SUBJECT;
}
export async function emitObserverInsights(input) {
    const embedding = input.embedding;
    try {
        if (!embedding?.isEnabled())
            return pausedResult();
        embedding.validateConfiguration();
        await embedding.validateReady?.({ signal: input.signal });
    }
    catch (error) {
        if (input.signal?.aborted)
            throw error;
        return pausedResult();
    }
    const patterns = input.patterns.listEligibleForApp
        ? await input.patterns.listEligibleForApp({
            appId: input.appId,
            limit: 20,
        })
        : [];
    const candidates = [
        ...input.drafts.map(normalizePageCandidate),
        ...patterns.map(normalizePatternCandidate),
    ].filter((candidate) => candidate !== null);
    if (candidates.length === 0) {
        const createdAt = nowIso();
        if (input.cursorTarget) {
            await input.repository.saveInsightCursor(input.appId, input.cursorSubject, {
                updatedAt: input.cursorTarget.updatedAt,
                pageId: input.cursorTarget.id,
            }, input.cursor, createdAt);
        }
        return {
            persisted: 0,
            deduplicated: 0,
            filtered: 0,
            message: 'Insight emission complete: 0 persisted, 0 deduplicated, 0 filtered.',
        };
    }
    let embeddings;
    try {
        embeddings = await embedding.embedMany(candidates.map((candidate) => candidate.content), { signal: input.signal });
        if (embeddings.length !== candidates.length ||
            embeddings.some((vector) => vector.length !== input.embeddingDimensions ||
                vector.some((value) => !Number.isFinite(value)))) {
            return pausedResult();
        }
    }
    catch (error) {
        if (input.signal?.aborted)
            throw error;
        return pausedResult();
    }
    const embedded = candidates.map((candidate, index) => ({
        ...candidate,
        embedding: embeddings[index],
    }));
    const activeMemoryBySubject = new Map(await Promise.all([...new Set(embedded.map((candidate) => candidate.subject))].map(async (subject) => [
        subject,
        await loadCanonicalActiveMemoryValues({
            memory: input.activeMemory,
            appId: input.appId,
            subject,
        }),
    ])));
    const accepted = [];
    let deduplicated = 0;
    let filtered = 0;
    for (const candidate of embedded) {
        input.signal?.throwIfAborted();
        const canonicalSignature = signatureFor(candidate.subject, candidate.signatureIdentity);
        if (candidate.insightType === 'repetition' &&
            (await input.repository.findHistoricalBySignature({
                appId: input.appId,
                subject: candidate.subject,
                canonicalSignature,
            }))) {
            continue;
        }
        const [exactInsight, semanticInsight] = await Promise.all([
            input.repository.findBySignature({
                appId: input.appId,
                subject: candidate.subject,
                canonicalSignature,
            }),
            input.repository.findSemanticDuplicate({
                appId: input.appId,
                subject: candidate.subject,
                model: input.embeddingModel,
                dimensions: input.embeddingDimensions,
                embedding: candidate.embedding,
                minSimilarity: OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD,
            }),
        ]);
        const activeMemoryDuplicate = activeMemoryBySubject.get(candidate.subject)?.has(candidate.content) ??
            false;
        const sameRunDuplicate = accepted.some((other) => other.subject === candidate.subject &&
            cosineSimilarity(other.embedding, candidate.embedding) >=
                OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD);
        const decision = evaluateObserverInsightFloor({
            confidence: candidate.confidence,
            evidenceCount: candidate.evidenceRefs.length,
            exactInsightDuplicate: exactInsight !== null,
            semanticInsightDuplicate: semanticInsight !== null || sameRunDuplicate,
            activeMemoryDuplicate,
        });
        if (!decision.accepted) {
            if (decision.reason === 'exact_insight_duplicate' ||
                decision.reason === 'semantic_insight_duplicate') {
                deduplicated += 1;
            }
            else {
                filtered += 1;
            }
            continue;
        }
        accepted.push(candidate);
    }
    let persisted = 0;
    const createdAt = nowIso();
    for (const candidate of accepted) {
        const canonicalSignature = signatureFor(candidate.subject, candidate.signatureIdentity);
        try {
            await input.repository.create({
                id: insightId(),
                appId: input.appId,
                subject: candidate.subject,
                insightType: candidate.insightType,
                title: candidate.title,
                summary: candidate.summary,
                evidenceRefs: candidate.evidenceRefs,
                batchSnapshotAt: candidate.batchSnapshotAt,
                evidenceVersion: 1,
                canonicalSignature,
                signatureEmbeddingRef: embeddingCacheTextHash(candidate.content),
                confidence: candidate.confidence,
                priorityScore: candidate.confidence,
                recipient: input.ownerRecipient,
                nowIso: createdAt,
            });
            persisted += 1;
        }
        catch (error) {
            if (!isUniqueViolation(error))
                throw error;
            deduplicated += 1;
        }
    }
    if (input.cursorTarget) {
        await input.repository.saveInsightCursor(input.appId, input.cursorSubject, {
            updatedAt: input.cursorTarget.updatedAt,
            pageId: input.cursorTarget.id,
        }, input.cursor, createdAt);
    }
    return {
        persisted,
        deduplicated,
        filtered,
        message: `Insight emission complete: ${persisted} persisted, ${deduplicated} deduplicated, ${filtered} filtered.`,
    };
}
export function normalizePageCandidate(input) {
    const content = canonicalizeObserverInsightText(input.draft.canonicalSignature);
    if (!content)
        return null;
    const subject = observerSubjectForPage(input.page);
    // Persist account-qualified provenance so digest freshness/permalinks can
    // tell the same jid on different provider accounts apart. Only channel pages
    // carry a messaging source ref; a non-channel ref that happens to contain a
    // colon (e.g. a URL) must NOT be parsed into a bogus jid — omit it and let
    // freshness fail closed. Legacy rows lack it and are handled the same way.
    const parsed = input.page.sourceKind === 'channel'
        ? parseChannelSourceRef(input.page.sourceRef)
        : null;
    return {
        subject,
        insightType: input.draft.insightType,
        title: input.draft.title,
        summary: input.draft.summary,
        content,
        signatureIdentity: content,
        confidence: input.draft.confidence,
        evidenceRefs: input.draft.evidencePageIds.map((messageId) => ({
            conversationId: subject,
            messageId,
            ts: input.page.updatedAt,
            ...(parsed
                ? {
                    providerAccountId: parsed.providerAccountId,
                    conversationJid: parsed.conversationJid,
                }
                : {}),
        })),
        batchSnapshotAt: input.page.updatedAt,
    };
}
function normalizePatternCandidate(candidate) {
    if (candidate.subjectType !== 'channel')
        return null;
    const conversationId = canonicalConversationIdForPattern(candidate.subjectId);
    const content = canonicalizeObserverInsightText(`repetition ${candidate.outcomeLabel}`);
    if (!conversationId || !content)
        return null;
    const subject = conversationId;
    const lastDetectedAt = isoTimestamp(candidate.lastDetectedAt);
    return {
        subject,
        insightType: 'repetition',
        title: `Repeated work: ${candidate.outcomeLabel}`,
        summary: candidate.shortAsk,
        content,
        signatureIdentity: `${content}\0repetition:v1:${candidate.occurrences}:${lastDetectedAt}`,
        confidence: 1,
        evidenceRefs: candidate.evidenceRefs
            .filter((reference) => reference.kind === 'transcript')
            .map((reference) => ({
            conversationId: subject,
            messageId: reference.id,
            ts: lastDetectedAt,
        })),
        batchSnapshotAt: lastDetectedAt,
    };
}
function signatureFor(subject, content) {
    return hash(`${subject}\0${content}`);
}
function insightId() {
    return `obs_${randomUUID().replace(/-/g, '')}`;
}
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function isoTimestamp(value) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds)
        ? new Date(milliseconds).toISOString()
        : value;
}
function stringValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function pausedResult() {
    return {
        persisted: 0,
        deduplicated: 0,
        filtered: 0,
        message: OBSERVER_EMBEDDINGS_UNAVAILABLE_MESSAGE,
    };
}

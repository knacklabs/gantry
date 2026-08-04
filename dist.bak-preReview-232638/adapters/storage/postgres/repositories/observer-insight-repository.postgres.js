import { and, asc, desc, eq, inArray, lt, lte, or, sql, } from 'drizzle-orm';
import { isObserverSubjectKey } from '../../../../domain/ports/observer-insights.js';
import * as pgSchema from '../schema/schema.js';
import { Deliveries, Insights, clampLimit, mapInsight, toIso, } from './observer-insight-repository.postgres.helpers.js';
import { claimPendingForDigest, findDigestReservation, findUnsettledDigestReservations, listDigestDeliveries, listPendingForDigest, recoverStaleDigestClaims, reserveDigest, settleDigest, } from './observer-insight-repository.postgres.digest.js';
const Embeddings = pgSchema.embeddingCachePostgres;
const Cursors = pgSchema.observerInsightCursorsPostgres;
const ACTIVE_INSIGHT_STATES = [
    'pending',
    'claimed',
    'sent',
    'cooldown',
];
const ALLOWED_TRANSITIONS = {
    pending: ['claimed', 'dropped'],
    claimed: ['pending', 'dropped'],
    sent: ['cooldown'],
    cooldown: ['resolved', 'dropped'],
    resolved: [],
    dropped: [],
};
export class PostgresObserverInsightRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async create(input) {
        assertCanonicalSubject(input.subject);
        const [row] = await this.db
            .insert(Insights)
            .values({
            id: input.id,
            appId: input.appId,
            subject: input.subject,
            insightType: input.insightType,
            title: input.title,
            summary: input.summary,
            evidenceRefs: input.evidenceRefs,
            batchSnapshotAt: input.batchSnapshotAt,
            evidenceVersion: input.evidenceVersion,
            canonicalSignature: input.canonicalSignature,
            signatureEmbeddingRef: input.signatureEmbeddingRef ?? null,
            confidence: input.confidence,
            priorityScore: input.priorityScore,
            state: 'pending',
            cooldownUntil: null,
            resolvedAt: null,
            surfacedAt: null,
            recipient: input.recipient,
            deliveryId: null,
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
        })
            .returning();
        return mapInsight(row);
    }
    async listPendingForSubject(input) {
        assertCanonicalSubject(input.subject);
        const rows = await this.db
            .select()
            .from(Insights)
            .where(and(eq(Insights.appId, input.appId), eq(Insights.subject, input.subject), eq(Insights.state, 'pending')))
            .orderBy(desc(Insights.priorityScore), asc(Insights.createdAt), asc(Insights.id))
            .limit(clampLimit(input.limit));
        return rows.map(mapInsight);
    }
    async list(input) {
        if (input.subject)
            assertCanonicalSubject(input.subject);
        const rows = await this.db
            .select()
            .from(Insights)
            .where(and(...insightFilters(input), keysetFilter(input.before)))
            .orderBy(desc(Insights.createdAt), desc(Insights.id))
            .limit(clampPageLimit(input.limit));
        return rows.map(mapInsight);
    }
    async count(input) {
        if (input.subject)
            assertCanonicalSubject(input.subject);
        const [row] = await this.db
            .select({ count: sql `count(*)::int` })
            .from(Insights)
            .where(and(...insightFilters(input)));
        return Number(row?.count ?? 0);
    }
    async findBySignature(input) {
        assertCanonicalSubject(input.subject);
        const [row] = await this.db
            .select()
            .from(Insights)
            .where(and(eq(Insights.subject, input.subject), eq(Insights.appId, input.appId), eq(Insights.canonicalSignature, input.canonicalSignature), inArray(Insights.state, ACTIVE_INSIGHT_STATES)))
            .orderBy(desc(Insights.createdAt), desc(Insights.id))
            .limit(1);
        return row ? mapInsight(row) : null;
    }
    async findHistoricalBySignature(input) {
        assertCanonicalSubject(input.subject);
        const [row] = await this.db
            .select()
            .from(Insights)
            .where(and(eq(Insights.subject, input.subject), eq(Insights.appId, input.appId), eq(Insights.canonicalSignature, input.canonicalSignature)))
            .orderBy(desc(Insights.createdAt), desc(Insights.id))
            .limit(1);
        return row ? mapInsight(row) : null;
    }
    async findSemanticDuplicate(input) {
        assertCanonicalSubject(input.subject);
        const vectorLiteral = `[${input.embedding.join(',')}]`;
        const similarity = sql `1 - (${Embeddings.embedding} <=> ${vectorLiteral}::vector)`;
        const [row] = await this.db
            .select({ insight: Insights, similarity })
            .from(Insights)
            .innerJoin(Embeddings, and(eq(Embeddings.textHash, Insights.signatureEmbeddingRef), eq(Embeddings.model, input.model), eq(Embeddings.dimensions, input.dimensions), sql `${Embeddings.embedding} is not null`))
            .where(and(eq(Insights.appId, input.appId), eq(Insights.subject, input.subject), inArray(Insights.state, ACTIVE_INSIGHT_STATES), sql `${similarity} >= ${input.minSimilarity}`))
            .orderBy(desc(similarity), desc(Insights.createdAt), desc(Insights.id))
            .limit(1);
        return row
            ? { insight: mapInsight(row.insight), similarity: Number(row.similarity) }
            : null;
    }
    async transitionState(input) {
        if (!ALLOWED_TRANSITIONS[input.from].includes(input.to)) {
            throw new Error(`Invalid observer insight transition: ${input.from} -> ${input.to}`);
        }
        if (input.from === 'claimed' && !input.claimedAt) {
            throw new Error('Observer claimed transition requires the expected claimedAt fence');
        }
        if (input.to === 'cooldown' && !input.cooldownUntil) {
            throw new Error('Observer insight cooldown transition requires cooldownUntil');
        }
        const set = {
            state: input.to,
            updatedAt: input.nowIso,
        };
        if (input.to === 'cooldown') {
            set.cooldownUntil = input.cooldownUntil;
        }
        if (input.to === 'resolved') {
            set.resolvedAt = input.resolvedAt ?? input.nowIso;
        }
        const [row] = await this.db
            .update(Insights)
            .set(set)
            .where(and(eq(Insights.id, input.id), eq(Insights.state, input.from), input.from === 'claimed'
            ? eq(Insights.updatedAt, input.claimedAt)
            : undefined))
            .returning();
        return row ? mapInsight(row) : null;
    }
    async recoverStaleClaims(input) {
        assertCanonicalSubject(input.subject);
        const staleBefore = Date.parse(input.staleBeforeIso);
        const recoveryTime = Date.parse(input.nowIso);
        if (!Number.isFinite(staleBefore) ||
            !Number.isFinite(recoveryTime) ||
            recoveryTime <= staleBefore) {
            throw new Error('Observer claim recovery time must follow the stale cutoff');
        }
        const rows = await this.db
            .update(Insights)
            .set({ state: 'pending', updatedAt: input.nowIso })
            .where(and(eq(Insights.appId, input.appId), eq(Insights.subject, input.subject), eq(Insights.state, 'claimed'), lte(Insights.updatedAt, input.staleBeforeIso)))
            .returning();
        return rows.map(mapInsight);
    }
    async markDelivered(input) {
        return this.db.transaction(async (tx) => {
            const [claimed] = await tx
                .select({ appId: Insights.appId, recipient: Insights.recipient })
                .from(Insights)
                .where(and(eq(Insights.id, input.id), eq(Insights.state, 'claimed'), eq(Insights.updatedAt, input.claimedAt)))
                .limit(1);
            if (!claimed)
                return null;
            const [delivery] = await tx
                .select({ id: Deliveries.id })
                .from(Deliveries)
                .where(and(eq(Deliveries.id, input.deliveryId), eq(Deliveries.appId, claimed.appId), eq(Deliveries.recipient, claimed.recipient)))
                .limit(1);
            if (!delivery) {
                throw new Error('Observer delivery must match the claimed insight app and recipient');
            }
            const [row] = await tx
                .update(Insights)
                .set({
                state: 'sent',
                deliveryId: input.deliveryId,
                surfacedAt: input.surfacedAt,
                updatedAt: input.nowIso,
            })
                .where(and(eq(Insights.id, input.id), eq(Insights.state, 'claimed'), eq(Insights.updatedAt, input.claimedAt)))
                .returning();
            return row ? mapInsight(row) : null;
        });
    }
    async recordDelivery(input) {
        const [row] = await this.db
            .insert(Deliveries)
            .values({
            id: input.id,
            appId: input.appId,
            recipient: input.recipient,
            localDay: input.localDay,
            createdAt: input.nowIso,
        })
            .returning();
        return mapDelivery(row);
    }
    claimPendingForDigest(input) {
        return claimPendingForDigest(this.db, input);
    }
    listPendingForDigest(input) {
        return listPendingForDigest(this.db, input);
    }
    listDigestDeliveries(input) {
        return listDigestDeliveries(this.db, input);
    }
    findDigestReservation(input) {
        return findDigestReservation(this.db, input);
    }
    findUnsettledDigestReservations(input) {
        return findUnsettledDigestReservations(this.db, input);
    }
    reserveDigest(input) {
        return reserveDigest(this.db, input);
    }
    settleDigest(input) {
        return settleDigest(this.db, input);
    }
    recoverStaleDigestClaims(input) {
        return recoverStaleDigestClaims(this.db, input);
    }
    async getInsightCursor(appId, subject) {
        assertCanonicalSubject(subject);
        const [row] = await this.db
            .select()
            .from(Cursors)
            .where(and(eq(Cursors.appId, appId), eq(Cursors.subject, subject)))
            .limit(1);
        return row?.cursorUpdatedAt && row.cursorPageId
            ? {
                updatedAt: toIso(row.cursorUpdatedAt),
                pageId: row.cursorPageId,
            }
            : null;
    }
    async saveInsightCursor(appId, subject, cursor, expectedCursor, nowIso) {
        assertCanonicalSubject(subject);
        if (expectedCursor && compareInsightCursors(cursor, expectedCursor) <= 0) {
            return false;
        }
        if (!expectedCursor) {
            const rows = await this.db
                .insert(Cursors)
                .values({
                appId,
                subject,
                cursorUpdatedAt: cursor.updatedAt,
                cursorPageId: cursor.pageId,
                updatedAt: nowIso,
            })
                .onConflictDoNothing({ target: [Cursors.appId, Cursors.subject] })
                .returning({ appId: Cursors.appId });
            return rows.length === 1;
        }
        const rows = await this.db
            .update(Cursors)
            .set({
            cursorUpdatedAt: cursor.updatedAt,
            cursorPageId: cursor.pageId,
            updatedAt: nowIso,
        })
            .where(and(eq(Cursors.appId, appId), eq(Cursors.subject, subject), eq(Cursors.cursorUpdatedAt, expectedCursor.updatedAt), eq(Cursors.cursorPageId, expectedCursor.pageId)))
            .returning({ appId: Cursors.appId });
        return rows.length === 1;
    }
}
function compareInsightCursors(left, right) {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
        throw new Error('Observer insight cursors require valid timestamps');
    }
    if (leftTime !== rightTime)
        return leftTime < rightTime ? -1 : 1;
    return left.pageId.localeCompare(right.pageId);
}
function insightFilters(input) {
    const filters = [eq(Insights.appId, input.appId)];
    if (input.subject !== undefined) {
        filters.push(eq(Insights.subject, input.subject));
    }
    if (input.state !== undefined) {
        filters.push(eq(Insights.state, input.state));
    }
    if (input.insightType !== undefined) {
        filters.push(eq(Insights.insightType, input.insightType));
    }
    return filters;
}
function keysetFilter(before) {
    if (!before)
        return undefined;
    return or(lt(Insights.createdAt, before.createdAt), and(eq(Insights.createdAt, before.createdAt), lt(Insights.id, before.id)));
}
function clampPageLimit(limit) {
    return Math.max(1, Math.min(limit, 101));
}
function assertCanonicalSubject(subject) {
    if (!isObserverSubjectKey(subject)) {
        throw new Error('Observer insight subject must be a valid observer subject key');
    }
}
function mapDelivery(row) {
    return {
        id: row.id,
        appId: row.appId,
        recipient: row.recipient,
        localDay: row.localDay,
        createdAt: toIso(row.createdAt),
    };
}

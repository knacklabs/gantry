import type { ObserverDelivery, ObserverDigestClaimMembership, ObserverDigestDeliverySummary, ObserverDigestReservation, ObserverDigestReserveResult, ObserverInsightCreate, ObserverInsightCursor, ObserverInsightRepository, ObserverInsightType, ObserverInsightState, ObserverSubjectKey, ProactiveInsight } from '../../../../domain/ports/observer-insights.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresObserverInsightRepository implements ObserverInsightRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    create(input: ObserverInsightCreate): Promise<ProactiveInsight>;
    listPendingForSubject(input: {
        appId: string;
        subject: ObserverSubjectKey;
        limit: number;
    }): Promise<ProactiveInsight[]>;
    list(input: {
        appId: string;
        subject?: ObserverSubjectKey;
        state?: ObserverInsightState;
        insightType?: ObserverInsightType;
        limit: number;
        before?: {
            createdAt: string;
            id: string;
        };
    }): Promise<ProactiveInsight[]>;
    count(input: {
        appId: string;
        subject?: ObserverSubjectKey;
        state?: ObserverInsightState;
        insightType?: ObserverInsightType;
    }): Promise<number>;
    findBySignature(input: {
        appId: string;
        canonicalSignature: string;
        subject: ObserverSubjectKey;
    }): Promise<ProactiveInsight | null>;
    findHistoricalBySignature(input: {
        appId: string;
        canonicalSignature: string;
        subject: ObserverSubjectKey;
    }): Promise<ProactiveInsight | null>;
    findSemanticDuplicate(input: {
        appId: string;
        subject: ObserverSubjectKey;
        model: string;
        dimensions: number;
        embedding: number[];
        minSimilarity: number;
    }): Promise<{
        insight: ProactiveInsight;
        similarity: number;
    } | null>;
    transitionState(input: {
        id: string;
        from: ObserverInsightState;
        to: ObserverInsightState;
        nowIso: string;
        claimedAt?: string;
        cooldownUntil?: string | null;
        resolvedAt?: string | null;
    }): Promise<ProactiveInsight | null>;
    recoverStaleClaims(input: {
        appId: string;
        subject: ObserverSubjectKey;
        staleBeforeIso: string;
        nowIso: string;
    }): Promise<ProactiveInsight[]>;
    markDelivered(input: {
        id: string;
        deliveryId: string;
        claimedAt: string;
        surfacedAt: string;
        nowIso: string;
    }): Promise<ProactiveInsight | null>;
    recordDelivery(input: {
        id: string;
        appId: string;
        recipient: string;
        localDay: string;
        nowIso: string;
    }): Promise<ObserverDelivery>;
    claimPendingForDigest(input: {
        appId: string;
        recipient: string;
        limit: number;
        nowIso: string;
    }): Promise<ProactiveInsight[]>;
    listPendingForDigest(input: {
        appId: string;
        recipient: string;
        limit: number;
    }): Promise<ProactiveInsight[]>;
    listDigestDeliveries(input: {
        appId: string;
        recipient: string;
        limit: number;
    }): Promise<ObserverDigestDeliverySummary[]>;
    findDigestReservation(input: {
        appId: string;
        recipient: string;
        localDay: string;
    }): Promise<ObserverDigestReservation | null>;
    findUnsettledDigestReservations(input: {
        appId: string;
        recipient: string;
    }): Promise<ObserverDigestReservation[]>;
    reserveDigest(input: {
        id: string;
        appId: string;
        recipient: string;
        localDay: string;
        timezone: string;
        conversationJid: string;
        providerAccountId: string;
        threadId?: string | null;
        renderedDigest: string;
        contentHash: string;
        memberships: ObserverDigestClaimMembership[];
        nowIso: string;
    }): Promise<ObserverDigestReserveResult>;
    settleDigest(input: {
        deliveryId: string;
        outboundDeliveryId: string;
        cooldownUntil: string;
        nowIso: string;
    }): Promise<ObserverDigestReservation | null>;
    recoverStaleDigestClaims(input: {
        appId: string;
        staleBeforeIso: string;
        nowIso: string;
    }): Promise<ProactiveInsight[]>;
    getInsightCursor(appId: string, subject: ObserverSubjectKey): Promise<ObserverInsightCursor | null>;
    saveInsightCursor(appId: string, subject: ObserverSubjectKey, cursor: ObserverInsightCursor, expectedCursor: ObserverInsightCursor | null, nowIso: string): Promise<boolean>;
}

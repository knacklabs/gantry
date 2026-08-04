import type { ObserverDigestClaimMembership, ObserverDigestDeliverySummary, ObserverDigestReservation, ObserverDigestReserveResult, ProactiveInsight } from '../../../../domain/ports/observer-insights.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function claimPendingForDigest(db: CanonicalDb, input: {
    appId: string;
    recipient: string;
    limit: number;
    nowIso: string;
}): Promise<ProactiveInsight[]>;
export declare function listPendingForDigest(db: CanonicalDb, input: {
    appId: string;
    recipient: string;
    limit: number;
}): Promise<ProactiveInsight[]>;
export declare function listDigestDeliveries(db: CanonicalDb, input: {
    appId: string;
    recipient: string;
    limit: number;
}): Promise<ObserverDigestDeliverySummary[]>;
export declare function findDigestReservation(db: CanonicalDb, input: {
    appId: string;
    recipient: string;
    localDay: string;
}): Promise<ObserverDigestReservation | null>;
export declare function findUnsettledDigestReservations(db: CanonicalDb, input: {
    appId: string;
    recipient: string;
}): Promise<ObserverDigestReservation[]>;
export declare function reserveDigest(db: CanonicalDb, input: {
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
export declare function settleDigest(db: CanonicalDb, input: {
    deliveryId: string;
    outboundDeliveryId: string;
    cooldownUntil: string;
    nowIso: string;
}): Promise<ObserverDigestReservation | null>;
export declare function recoverStaleDigestClaims(db: CanonicalDb, input: {
    appId: string;
    staleBeforeIso: string;
    nowIso: string;
}): Promise<ProactiveInsight[]>;

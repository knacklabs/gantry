import type { ObserverDeliveryIneligibleReason } from '../config/settings/observer-activation.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import type { ObserverDigestReservation, ObserverInsightRepository, ProactiveInsight } from '../domain/ports/observer-insights.js';
import type { InsightFreshnessProbe } from './observer-evidence-freshness.js';
export declare const OBSERVER_DIGEST_COOLDOWN_MS: number;
/**
 * The seam that performs the durable outbound send. Kept narrow so the digest
 * pipeline never touches provider transport directly and tests inject a fake.
 * `durablySent` is true only once the outbound delivery is durably recorded as
 * sent — that is the ONLY signal that permits settling the reservation.
 */
export interface DigestSendGateway {
    enqueue(input: {
        appId: string;
        conversationJid: string;
        providerAccountId: string;
        threadId: string | null;
        idempotencyKey: string;
        text: string;
    }): Promise<{
        outboundDeliveryId: string;
        durablySent: boolean;
    }>;
}
/**
 * Hand-off seam for a reserved digest. The production implementation
 * (createOutboundDigestDeliveryPort) enqueues the durable send and settles only
 * after it is durably sent. The no-op stays for unit tests only.
 */
export interface DigestDeliveryPort {
    deliver(reservation: ObserverDigestReservation): Promise<void>;
}
export declare const noopDigestDeliveryPort: DigestDeliveryPort;
/** Deterministic per-(app, recipient, day) outbound idempotency key. */
export declare function digestOutboundIdempotencyKey(reservation: {
    appId: string;
    recipient: string;
    localDay: string;
}): string;
/**
 * Production delivery port: durable enqueue + settle-after-durable-sent.
 * - Enqueue is idempotent on the deterministic key, so re-driving a reservation
 *   never produces a duplicate outbound message.
 * - settleDigest (members sent -> cooldown) runs ONLY once the outbound is
 *   durably sent. A failed/pending send leaves the reservation UNSETTLED and its
 *   members claimed, so the next tick retries the same reservation.
 */
export declare function createOutboundDigestDeliveryPort(deps: {
    gateway: DigestSendGateway;
    repository: Pick<ObserverInsightRepository, 'settleDigest'>;
    now: () => string;
    cooldownMs?: number;
}): DigestDeliveryPort;
export interface RunObserverDigestDeps {
    settings: RuntimeSettings;
    repository: ObserverInsightRepository;
    freshnessProbe: InsightFreshnessProbe;
    deliveryPort: DigestDeliveryPort;
    idFactory?: () => string;
}
export type RunObserverDigestSkipReason = ObserverDeliveryIneligibleReason | 'before_send_window' | 'quiet_hours' | 'already_delivered' | 'already_reserved' | 'deferred_quiet_hours' | 'no_qualifying_insights';
export type RunObserverDigestResult = {
    status: 'reserved';
    reservationId: string;
    localDay: string;
    selected: number;
} | {
    status: 'retried';
    reservationId: string;
    localDay: string;
} | {
    status: 'skipped';
    reason: RunObserverDigestSkipReason;
};
export declare function runObserverDigest(input: {
    appId: string;
    nowIso: string;
    deps: RunObserverDigestDeps;
}): Promise<RunObserverDigestResult>;
export interface ObserverDigestPreview {
    localDay: string;
    selected: ProactiveInsight[];
    renderedDigest: string | null;
    skippedReason: 'no_qualifying_insights' | null;
}
/**
 * Dry-run digest assembly: apply the SAME freshness + value floor + stable
 * top-N selection + render that runObserverDigest uses, over a caller-supplied
 * candidate pool. Claim-free, reserve-free, send-free — it reads freshness and
 * returns what WOULD be sent, writing nothing. The candidate pool must be read
 * with listPendingForDigest (not claimPendingForDigest) to keep it that way.
 */
export declare function buildDigestPreview(input: {
    nowIso: string;
    timezone: string;
    maxInsights: number;
    candidates: ProactiveInsight[];
    freshnessProbe: InsightFreshnessProbe;
}): Promise<ObserverDigestPreview>;
/** Generous prefetch so freshness + floor drops still leave enough survivors. */
export declare function digestPrefetchLimit(maxInsights: number): number;

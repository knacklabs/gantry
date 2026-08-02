import * as pgSchema from '../schema/schema.js';
// Schema tables and row mappers shared between the insight-CRUD repository
// (observer-insight-repository.postgres.ts) and the digest-delivery methods
// (observer-insight-repository.postgres.digest.ts).
export const Insights = pgSchema.proactiveInsightsPostgres;
export const Deliveries = pgSchema.observerDeliveriesPostgres;
export function clampLimit(limit) {
    return Math.max(1, Math.min(limit, 100));
}
export function toIso(value) {
    return new Date(value).toISOString();
}
export function nullableIso(value) {
    return value ? toIso(value) : null;
}
export function mapInsight(row) {
    return {
        id: row.id,
        appId: row.appId,
        subject: row.subject,
        insightType: row.insightType,
        title: row.title,
        summary: row.summary,
        evidenceRefs: Array.isArray(row.evidenceRefs)
            ? row.evidenceRefs
            : [],
        batchSnapshotAt: toIso(row.batchSnapshotAt),
        evidenceVersion: row.evidenceVersion,
        canonicalSignature: row.canonicalSignature,
        signatureEmbeddingRef: row.signatureEmbeddingRef ?? null,
        confidence: row.confidence,
        priorityScore: row.priorityScore,
        state: row.state,
        cooldownUntil: nullableIso(row.cooldownUntil),
        resolvedAt: nullableIso(row.resolvedAt),
        surfacedAt: nullableIso(row.surfacedAt),
        recipient: row.recipient,
        deliveryId: row.deliveryId ?? null,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
    };
}

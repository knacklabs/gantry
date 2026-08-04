import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import * as pgSchema from '../schema/schema.js';
import { nowMs as currentTimeMs } from '../../../../shared/time/datetime.js';
export function encodeJson(value) {
    return JSON.stringify(value ?? null);
}
function parseJson(value, fallback) {
    if (typeof value !== 'string' || value.length === 0)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
export function isUniqueViolation(err) {
    // Drizzle wraps the pg error (the SQLSTATE lives on the cause chain), so
    // walk causes like file-artifact-repository's sqlStateCode does.
    let current = err;
    for (let depth = 0; depth < 5; depth += 1) {
        if (!current || typeof current !== 'object')
            return false;
        const code = current.code;
        if (code === '23505')
            return true;
        current = current.cause;
    }
    return false;
}
export function mapDelivery(row) {
    return {
        id: row.id,
        appId: row.appId,
        conversationId: row.conversationId,
        threadId: row.threadId
            ? row.threadId
            : undefined,
        agentId: row.agentId
            ? row.agentId
            : undefined,
        runId: row.runId ? row.runId : undefined,
        profileId: row.profileId,
        idempotencyKey: row.idempotencyKey,
        idempotencyFingerprint: row.idempotencyFingerprint,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        settledAt: row.settledAt ?? undefined,
        lastError: row.lastError ?? undefined,
    };
}
export function mapItem(row) {
    const providerPayload = sanitizeRetryTailProviderPayload(parseJson(row.providerPayloadJson, null));
    return {
        id: row.id,
        deliveryId: row.deliveryId,
        ordinal: row.ordinal,
        canonicalText: row.canonicalText,
        providerPayload,
        status: row.status,
        attemptCount: row.attemptCount,
        claimToken: row.claimToken ?? undefined,
        claimExpiresAt: row.claimExpiresAt ?? undefined,
        nextAttemptAt: row.nextAttemptAt,
        sentAt: row.sentAt ?? undefined,
        failedAt: row.failedAt ?? undefined,
        lastError: row.lastError ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
export function mapFinalAnswer(row) {
    return {
        deliveryId: row.deliveryId,
        canonicalText: row.canonicalText,
        segmentCount: row.segmentCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
export function mapReceipt(row) {
    const providerPayload = sanitizeRetryTailProviderPayload(parseJson(row.providerPayloadJson, null));
    return {
        id: row.id,
        deliveryId: row.deliveryId,
        itemId: row.itemId,
        idempotencyKey: row.idempotencyKey,
        providerMessageId: row.providerMessageId ?? undefined,
        providerPayload,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
    };
}
export function computeLeaseExpiry(now, leaseMs) {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms))
        return new Date(currentTimeMs() + leaseMs).toISOString();
    return new Date(ms + leaseMs).toISOString();
}
export function computeRetryBackoffMs(input) {
    const exponent = Math.max(0, input.attemptCount - 1);
    const raw = input.baseDelayMs * 2 ** exponent;
    return Math.min(raw, input.maxDelayMs);
}
function parseTimestampMs(value) {
    if (!value)
        return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}
export function timestampsRepresentSameInstant(left, right) {
    if (left === right)
        return true;
    const leftMs = parseTimestampMs(left);
    const rightMs = parseTimestampMs(right);
    if (leftMs === null || rightMs === null)
        return false;
    return leftMs === rightMs;
}
export function normalizeRetryTail(retryTail) {
    if (!retryTail)
        return undefined;
    const canonicalText = retryTail.canonicalText.replace(/\r\n/g, '\n');
    if (!canonicalText.trim())
        return undefined;
    const providerPayload = retryTail.providerPayload === undefined
        ? undefined
        : sanitizeRetryTailProviderPayload(retryTail.providerPayload);
    return {
        canonicalText,
        ...(providerPayload !== undefined ? { providerPayload } : {}),
    };
}
export function buildPartialDeliveryError(input) {
    const error = input.error.trim() || 'Outbound delivery partially delivered.';
    if (Number.isSafeInteger(input.deliveredParts) &&
        Number.isSafeInteger(input.totalParts) &&
        input.deliveredParts > 0 &&
        input.totalParts > 0) {
        return `${error} (delivered ${input.deliveredParts} of ${input.totalParts})`;
    }
    return error;
}
export function deriveOutboundDeliveryStatus(input) {
    const { counts, earliestUnsentStatus } = input;
    if (!earliestUnsentStatus)
        return 'sent';
    if (earliestUnsentStatus === 'pending') {
        return counts.claimed > 0 ? 'claimed' : 'pending';
    }
    if (earliestUnsentStatus === 'claimed') {
        return 'claimed';
    }
    if (earliestUnsentStatus === 'partially_delivered') {
        return 'partially_delivered';
    }
    if (earliestUnsentStatus === 'failed') {
        return counts.sent > 0 ? 'partially_delivered' : 'failed';
    }
    if (counts.pending > 0) {
        return counts.claimed > 0 ? 'claimed' : 'pending';
    }
    if (counts.claimed > 0)
        return 'claimed';
    if (counts.partiallyDelivered > 0)
        return 'partially_delivered';
    if (counts.failed === 0)
        return 'sent';
    return counts.sent === 0 ? 'failed' : 'partially_delivered';
}
export async function recomputeOutboundDeliveryStatus(tx, input) {
    const rows = await tx
        .select({
        status: pgSchema.outboundDeliveryItemsPostgres.status,
        count: sql `count(*)`,
    })
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(eq(pgSchema.outboundDeliveryItemsPostgres.deliveryId, input.deliveryId))
        .groupBy(pgSchema.outboundDeliveryItemsPostgres.status);
    if (rows.length === 0)
        return input.getDeliveryById(tx, input.deliveryId);
    const counts = {};
    for (const row of rows)
        counts[row.status] = Number(row.count);
    const statusCounts = {
        pending: counts.pending ?? 0,
        claimed: counts.claimed ?? 0,
        sent: counts.sent ?? 0,
        failed: counts.failed ?? 0,
        partiallyDelivered: counts.partially_delivered ?? 0,
    };
    const earliestUnsent = await tx
        .select({
        status: pgSchema.outboundDeliveryItemsPostgres.status,
    })
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(and(eq(pgSchema.outboundDeliveryItemsPostgres.deliveryId, input.deliveryId), sql `${pgSchema.outboundDeliveryItemsPostgres.status} <> 'sent'`))
        .orderBy(asc(pgSchema.outboundDeliveryItemsPostgres.ordinal))
        .limit(1);
    const status = deriveOutboundDeliveryStatus({
        counts: statusCounts,
        earliestUnsentStatus: earliestUnsent[0]?.status,
    });
    let lastError = null;
    if (statusCounts.failed > 0 || statusCounts.partiallyDelivered > 0) {
        const errors = await tx
            .select({
            lastError: pgSchema.outboundDeliveryItemsPostgres.lastError,
        })
            .from(pgSchema.outboundDeliveryItemsPostgres)
            .where(and(eq(pgSchema.outboundDeliveryItemsPostgres.deliveryId, input.deliveryId), inArray(pgSchema.outboundDeliveryItemsPostgres.status, [
            'failed',
            'partially_delivered',
        ])))
            .orderBy(sql `${pgSchema.outboundDeliveryItemsPostgres.failedAt} DESC NULLS LAST`)
            .limit(1);
        lastError = errors[0]?.lastError ?? null;
    }
    const updateTime = input.now ?? input.fallbackNow();
    const settledAt = status === 'sent' || status === 'failed' || status === 'partially_delivered'
        ? updateTime
        : null;
    const updated = await tx
        .update(pgSchema.outboundDeliveriesPostgres)
        .set({
        status,
        settledAt,
        lastError,
        updatedAt: updateTime,
    })
        .where(eq(pgSchema.outboundDeliveriesPostgres.id, input.deliveryId))
        .returning();
    return updated[0] ? mapDelivery(updated[0]) : null;
}

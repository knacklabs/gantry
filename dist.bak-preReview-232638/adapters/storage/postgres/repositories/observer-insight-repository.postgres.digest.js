import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
import { Deliveries, Insights, clampLimit, mapInsight, nullableIso, toIso, } from './observer-insight-repository.postgres.helpers.js';
const DeliveryInsights = pgSchema.observerDeliveryInsightsPostgres;
function mapReservation(row) {
    return {
        id: row.id,
        appId: row.appId,
        recipient: row.recipient,
        localDay: row.localDay,
        state: row.state,
        timezone: row.timezone ?? null,
        conversationJid: row.conversationJid ?? null,
        providerAccountId: row.providerAccountId ?? null,
        threadId: row.threadId ?? null,
        renderedDigest: row.renderedDigest ?? null,
        contentHash: row.contentHash ?? null,
        outboundDeliveryId: row.outboundDeliveryId ?? null,
        reservedAt: nullableIso(row.reservedAt),
        sentAt: nullableIso(row.sentAt),
        settledAt: nullableIso(row.settledAt),
        createdAt: toIso(row.createdAt),
    };
}
export async function claimPendingForDigest(db, input) {
    return db.transaction(async (tx) => {
        const locked = await tx
            .select({ id: Insights.id })
            .from(Insights)
            .where(and(eq(Insights.appId, input.appId), eq(Insights.recipient, input.recipient), eq(Insights.state, 'pending')))
            .orderBy(desc(Insights.priorityScore), asc(Insights.createdAt), asc(Insights.id))
            .limit(clampLimit(input.limit))
            .for('update', { skipLocked: true });
        if (locked.length === 0)
            return [];
        const rows = await tx
            .update(Insights)
            .set({ state: 'claimed', updatedAt: input.nowIso })
            .where(inArray(Insights.id, locked.map((row) => row.id)))
            .returning();
        // UPDATE ... RETURNING has no defined order; membership positions depend
        // on priority order, so re-sort by the ordered id sequence we locked.
        const order = new Map(locked.map((row, index) => [row.id, index]));
        return rows
            .map(mapInsight)
            .sort((left, right) => order.get(left.id) - order.get(right.id));
    });
}
export async function listPendingForDigest(db, input) {
    const rows = await db
        .select()
        .from(Insights)
        .where(and(eq(Insights.appId, input.appId), eq(Insights.recipient, input.recipient), eq(Insights.state, 'pending')))
        .orderBy(desc(Insights.priorityScore), asc(Insights.createdAt), asc(Insights.id))
        .limit(clampLimit(input.limit));
    return rows.map(mapInsight);
}
export async function listDigestDeliveries(db, input) {
    const insightCount = sql `count(${DeliveryInsights.insightId})::int`;
    const rows = await db
        .select({
        id: Deliveries.id,
        localDay: Deliveries.localDay,
        state: Deliveries.state,
        reservedAt: Deliveries.reservedAt,
        sentAt: Deliveries.sentAt,
        settledAt: Deliveries.settledAt,
        createdAt: Deliveries.createdAt,
        insightCount,
    })
        .from(Deliveries)
        .leftJoin(DeliveryInsights, eq(DeliveryInsights.deliveryId, Deliveries.id))
        .where(and(eq(Deliveries.appId, input.appId), eq(Deliveries.recipient, input.recipient)))
        .groupBy(Deliveries.id)
        .orderBy(desc(Deliveries.createdAt), desc(Deliveries.id))
        .limit(clampLimit(input.limit));
    return rows.map((row) => ({
        id: row.id,
        localDay: row.localDay,
        state: row.state,
        insightCount: Number(row.insightCount ?? 0),
        reservedAt: nullableIso(row.reservedAt),
        sentAt: nullableIso(row.sentAt),
        settledAt: nullableIso(row.settledAt),
        createdAt: toIso(row.createdAt),
    }));
}
export async function findDigestReservation(db, input) {
    const [row] = await db
        .select()
        .from(Deliveries)
        .where(and(eq(Deliveries.appId, input.appId), eq(Deliveries.recipient, input.recipient), eq(Deliveries.localDay, input.localDay)))
        .limit(1);
    return row ? mapReservation(row) : null;
}
export async function findUnsettledDigestReservations(db, input) {
    const rows = await db
        .select()
        .from(Deliveries)
        .where(and(eq(Deliveries.appId, input.appId), eq(Deliveries.recipient, input.recipient), inArray(Deliveries.state, ['reserved', 'sent'])))
        .orderBy(asc(Deliveries.createdAt), asc(Deliveries.id));
    return rows.map(mapReservation);
}
export async function reserveDigest(db, input) {
    return db.transaction(async (tx) => {
        const [inserted] = await tx
            .insert(Deliveries)
            .values({
            id: input.id,
            appId: input.appId,
            recipient: input.recipient,
            localDay: input.localDay,
            state: 'reserved',
            timezone: input.timezone,
            conversationJid: input.conversationJid,
            providerAccountId: input.providerAccountId,
            threadId: input.threadId ?? null,
            renderedDigest: input.renderedDigest,
            contentHash: input.contentHash,
            reservedAt: input.nowIso,
            createdAt: input.nowIso,
        })
            .onConflictDoNothing({
            target: [Deliveries.appId, Deliveries.recipient, Deliveries.localDay],
        })
            .returning();
        if (inserted) {
            if (input.memberships.length > 0) {
                await tx.insert(DeliveryInsights).values(input.memberships.map((membership) => ({
                    deliveryId: inserted.id,
                    insightId: membership.insightId,
                    claimedAt: membership.claimedAt,
                    position: membership.position,
                })));
            }
            return { reservation: mapReservation(inserted), created: true };
        }
        // Unique key already claimed this (app, recipient, day): the reservation
        // is at-most-once, so return the existing one and add no membership.
        const [existing] = await tx
            .select()
            .from(Deliveries)
            .where(and(eq(Deliveries.appId, input.appId), eq(Deliveries.recipient, input.recipient), eq(Deliveries.localDay, input.localDay)))
            .limit(1);
        if (!existing) {
            throw new Error('Observer digest reservation conflict without a row');
        }
        return { reservation: mapReservation(existing), created: false };
    });
}
export async function settleDigest(db, input) {
    return db.transaction(async (tx) => {
        const [delivery] = await tx
            .select()
            .from(Deliveries)
            .where(eq(Deliveries.id, input.deliveryId))
            .limit(1)
            // Lock the delivery row so the state check below and the final
            // transition are atomic. A concurrent settle blocks here, then reads
            // the committed `settled` state and returns it idempotently instead of
            // racing past the check and losing the compare-and-set (returning null).
            .for('update');
        if (!delivery)
            return null;
        // Idempotent: an already-settled delivery is returned untouched (never
        // overwrite its outboundDeliveryId/timestamps). Never settle a `failed`
        // delivery.
        if (delivery.state === 'settled')
            return mapReservation(delivery);
        if (delivery.state !== 'reserved' && delivery.state !== 'sent') {
            return null;
        }
        const memberships = await tx
            .select()
            .from(DeliveryInsights)
            .where(eq(DeliveryInsights.deliveryId, input.deliveryId));
        for (const membership of memberships) {
            const [sent] = await tx
                .update(Insights)
                .set({
                state: 'sent',
                deliveryId: input.deliveryId,
                surfacedAt: input.nowIso,
                updatedAt: input.nowIso,
            })
                .where(and(eq(Insights.id, membership.insightId), eq(Insights.state, 'claimed'), eq(Insights.updatedAt, membership.claimedAt)))
                .returning({ id: Insights.id });
            if (!sent) {
                // Fence didn't match: this member was NOT sent. Leaving it `claimed`
                // under a settled delivery strands it forever (recover excludes
                // settled-delivery members). Release it so recovery/next digest can
                // reclaim it.
                await tx
                    .update(Insights)
                    .set({ state: 'pending', updatedAt: input.nowIso })
                    .where(and(eq(Insights.id, membership.insightId), eq(Insights.state, 'claimed')));
                continue;
            }
            // The row is locked by the update above for the rest of this txn, so
            // the state='sent' guard alone is a sound fence for the cooldown step.
            await tx
                .update(Insights)
                .set({
                state: 'cooldown',
                cooldownUntil: input.cooldownUntil,
                updatedAt: input.nowIso,
            })
                .where(and(eq(Insights.id, membership.insightId), eq(Insights.state, 'sent')));
        }
        const [settled] = await tx
            .update(Deliveries)
            .set({
            state: 'settled',
            outboundDeliveryId: input.outboundDeliveryId,
            sentAt: delivery.sentAt ?? input.nowIso,
            settledAt: input.nowIso,
        })
            .where(and(eq(Deliveries.id, input.deliveryId), inArray(Deliveries.state, ['reserved', 'sent'])))
            .returning();
        return settled ? mapReservation(settled) : null;
    });
}
export async function recoverStaleDigestClaims(db, input) {
    const staleBefore = Date.parse(input.staleBeforeIso);
    const recoveryTime = Date.parse(input.nowIso);
    if (!Number.isFinite(staleBefore) ||
        !Number.isFinite(recoveryTime) ||
        recoveryTime <= staleBefore) {
        throw new Error('Observer claim recovery time must follow the stale cutoff');
    }
    const rows = await db
        .update(Insights)
        .set({ state: 'pending', updatedAt: input.nowIso })
        .where(and(eq(Insights.appId, input.appId), eq(Insights.state, 'claimed'), lte(Insights.updatedAt, input.staleBeforeIso), sql `${Insights.id} NOT IN (
            SELECT ${DeliveryInsights.insightId}
            FROM ${DeliveryInsights}
            INNER JOIN ${Deliveries}
              ON ${Deliveries.id} = ${DeliveryInsights.deliveryId}
            WHERE ${Deliveries.state} IN ('reserved', 'sent', 'settled')
          )`))
        .returning();
    return rows.map(mapInsight);
}

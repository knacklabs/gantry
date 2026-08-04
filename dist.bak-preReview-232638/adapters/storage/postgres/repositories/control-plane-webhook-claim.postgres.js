import { and, asc, inArray, sql } from 'drizzle-orm';
import { nowIso as currentIso, nowMs as currentTimeMs, } from '../../../../shared/time/datetime.js';
import { mapDelivery, mapEvent, mapWebhook, } from '../schema/control-plane-canonical.postgres.js';
import * as pgSchema from '../schema/schema.js';
const CLAIMABLE_DELIVERY_STATUSES = ['pending', 'retrying', 'delivering'];
export async function claimDueWebhookDeliveriesWithDrizzleLock(db, limit = 50) {
    return db.transaction(async (tx) => {
        const now = currentIso();
        const leaseUntil = new Date(currentTimeMs() + 15_000).toISOString();
        const candidates = await tx
            .select({
            deliveryId: pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
        })
            .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .where(and(inArray(pgSchema.controlHttpWebhookDeliveriesPostgres.status, CLAIMABLE_DELIVERY_STATUSES), sql `${pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt} <= ${now}`))
            .orderBy(asc(pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt), asc(pgSchema.controlHttpWebhookDeliveriesPostgres.createdAt))
            .limit(limit)
            .for('update', { skipLocked: true });
        const deliveryIds = candidates.map((candidate) => candidate.deliveryId);
        if (deliveryIds.length === 0)
            return [];
        const rows = await tx
            .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .set({
            status: 'delivering',
            attemptCount: sql `${pgSchema.controlHttpWebhookDeliveriesPostgres.attemptCount} + 1`,
            nextAttemptAt: leaseUntil,
            lastAttemptAt: now,
            updatedAt: now,
            lastError: null,
        })
            .where(inArray(pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId, deliveryIds))
            .returning();
        const claimed = rows.map((row) => mapDelivery(row));
        return hydrateClaimedDeliveries(tx, claimed);
    });
}
async function hydrateClaimedDeliveries(db, claimed) {
    if (claimed.length === 0)
        return [];
    const webhookIds = [...new Set(claimed.map((row) => row.webhookId))];
    const eventIds = [...new Set(claimed.map((row) => row.eventId))];
    const webhookRows = await db
        .select()
        .from(pgSchema.controlHttpWebhooksPostgres)
        .where(inArray(pgSchema.controlHttpWebhooksPostgres.webhookId, webhookIds));
    const eventRows = await db
        .select()
        .from(pgSchema.runtimeEventsPostgres)
        .where(inArray(pgSchema.runtimeEventsPostgres.eventId, eventIds));
    const webhooks = new Map(webhookRows.map((row) => [
        row.webhookId,
        { ...mapWebhook(row), secret: row.secret },
    ]));
    const events = new Map(eventRows.map((row) => [row.eventId, mapEvent(row)]));
    return claimed.map((delivery) => {
        const event = events.get(delivery.eventId) ?? null;
        return {
            ...delivery,
            webhook: webhooks.get(delivery.webhookId) ?? null,
            event,
            eventAppId: event ? event.appId : null,
        };
    });
}

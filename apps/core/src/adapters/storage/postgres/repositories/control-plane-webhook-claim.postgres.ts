import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import type {
  ClaimedWebhookDeliveryRecord,
  WebhookDeliveryRecord,
} from '../schema/control-plane-records.postgres.js';
import {
  mapDelivery,
  mapEvent,
  mapWebhook,
  type CanonicalControlRow,
} from '../schema/control-plane-canonical.postgres.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';

const CLAIMABLE_DELIVERY_STATUSES = ['pending', 'retrying', 'delivering'];

export async function claimDueWebhookDeliveriesWithDrizzleLock(
  db: CanonicalDb,
  limit = 50,
): Promise<ClaimedWebhookDeliveryRecord[]> {
  return db.transaction(async (tx) => {
    const now = currentIso();
    const leaseUntil = new Date(Date.now() + 15_000).toISOString();
    const candidates = await tx
      .select()
      .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .where(
        and(
          inArray(
            pgSchema.controlHttpWebhookDeliveriesPostgres.status,
            CLAIMABLE_DELIVERY_STATUSES,
          ),
          sql`${pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt} <= ${now}`,
        ),
      )
      .orderBy(
        asc(pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt),
        asc(pgSchema.controlHttpWebhookDeliveriesPostgres.createdAt),
      )
      .limit(limit)
      .for('update', { skipLocked: true });

    const claimed: WebhookDeliveryRecord[] = [];
    for (const candidate of candidates) {
      const rows = await tx
        .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
        .set({
          status: 'delivering',
          attemptCount: sql`${pgSchema.controlHttpWebhookDeliveriesPostgres.attemptCount} + 1`,
          nextAttemptAt: leaseUntil,
          lastAttemptAt: now,
          updatedAt: now,
          lastError: null,
        })
        .where(
          eq(
            pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
            candidate.deliveryId,
          ),
        )
        .returning();
      if (rows[0]) claimed.push(mapDelivery(rows[0] as CanonicalControlRow));
    }
    return hydrateClaimedDeliveries(tx, claimed);
  });
}

async function hydrateClaimedDeliveries(
  db: CanonicalExecutor,
  claimed: WebhookDeliveryRecord[],
): Promise<ClaimedWebhookDeliveryRecord[]> {
  if (claimed.length === 0) return [];
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
  const webhooks = new Map(
    webhookRows.map((row) => [
      row.webhookId,
      { ...mapWebhook(row as CanonicalControlRow), secret: row.secret },
    ]),
  );
  const events = new Map(
    eventRows.map((row) => [row.eventId, mapEvent(row as CanonicalControlRow)]),
  );
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

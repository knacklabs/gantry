import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type {
  ClaimedOutboundDeliveryItem,
  OutboundDelivery,
} from '../../../../domain/outbound-delivery/outbound-delivery.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  computeLeaseExpiry,
  mapDelivery,
  mapFinalAnswer,
  mapItem,
  type ItemRow,
} from './outbound-delivery-repository.postgres.helpers.js';

const EXPIRED_CLAIM_AMBIGUOUS_ERROR =
  'Outbound delivery claim expired after provider-dispatch crash window; automatic retry was disabled to avoid blind redispatch.';

export async function claimDueOutboundDeliveryItems(
  db: CanonicalDb,
  input: {
    appId?: OutboundDelivery['appId'];
    profileId?: string;
    now: string;
    claimerId: string;
    leaseMs: number;
    limit: number;
  },
  createClaimToken: () => string,
): Promise<ClaimedOutboundDeliveryItem[]> {
  return db.transaction(async (tx) => {
    const validDeliveryThreadClause = or(
      isNull(pgSchema.outboundDeliveriesPostgres.threadId),
      sql`EXISTS (
        SELECT 1
        FROM ${pgSchema.conversationThreadsPostgres} AS t
        WHERE t.id = ${pgSchema.outboundDeliveriesPostgres.threadId}
          AND t.app_id = ${pgSchema.outboundDeliveriesPostgres.appId}
          AND t.conversation_id = ${pgSchema.outboundDeliveriesPostgres.conversationId}
      )`,
    );
    const expiredClaimCandidates = await tx
      .select({
        id: pgSchema.outboundDeliveryItemsPostgres.id,
        deliveryId: pgSchema.outboundDeliveryItemsPostgres.deliveryId,
      })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .innerJoin(
        pgSchema.outboundDeliveriesPostgres,
        eq(
          pgSchema.outboundDeliveryItemsPostgres.deliveryId,
          pgSchema.outboundDeliveriesPostgres.id,
        ),
      )
      .where(
        and(
          eq(pgSchema.outboundDeliveryItemsPostgres.status, 'claimed'),
          sql`${pgSchema.outboundDeliveryItemsPostgres.claimExpiresAt} IS NOT NULL`,
          lte(pgSchema.outboundDeliveryItemsPostgres.claimExpiresAt, input.now),
          input.appId
            ? eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId)
            : undefined,
          input.profileId
            ? eq(pgSchema.outboundDeliveriesPostgres.profileId, input.profileId)
            : undefined,
          validDeliveryThreadClause,
        ),
      )
      .orderBy(
        asc(pgSchema.outboundDeliveryItemsPostgres.claimExpiresAt),
        asc(pgSchema.outboundDeliveryItemsPostgres.updatedAt),
        asc(pgSchema.outboundDeliveryItemsPostgres.id),
      )
      .limit(input.limit)
      .for('update', {
        of: pgSchema.outboundDeliveryItemsPostgres,
        skipLocked: true,
      });
    if (expiredClaimCandidates.length > 0) {
      const expiredClaimItemIds = expiredClaimCandidates.map((row) => row.id);
      await tx
        .update(pgSchema.outboundDeliveryItemsPostgres)
        .set({
          status: 'partially_delivered',
          failedAt: input.now,
          lastError: EXPIRED_CLAIM_AMBIGUOUS_ERROR,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
          nextAttemptAt: input.now,
          updatedAt: input.now,
        })
        .where(
          inArray(
            pgSchema.outboundDeliveryItemsPostgres.id,
            expiredClaimItemIds,
          ),
        );
    }
    const ambiguousDeliveryIds = [
      ...new Set(expiredClaimCandidates.map((row) => row.deliveryId)),
    ];
    if (ambiguousDeliveryIds.length > 0) {
      await tx
        .update(pgSchema.outboundDeliveriesPostgres)
        .set({
          status: 'partially_delivered',
          settledAt: input.now,
          lastError: EXPIRED_CLAIM_AMBIGUOUS_ERROR,
          updatedAt: input.now,
        })
        .where(
          and(
            inArray(
              pgSchema.outboundDeliveriesPostgres.id,
              ambiguousDeliveryIds,
            ),
            input.appId
              ? eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId)
              : undefined,
          ),
        );
    }

    const duePending = and(
      eq(pgSchema.outboundDeliveryItemsPostgres.status, 'pending'),
      lte(pgSchema.outboundDeliveryItemsPostgres.nextAttemptAt, input.now),
    );
    const nextUnsentOrdinalExpr = sql<number>`(
      SELECT min(i2.ordinal)
      FROM ${pgSchema.outboundDeliveryItemsPostgres} AS i2
      WHERE i2.delivery_id = ${pgSchema.outboundDeliveryItemsPostgres.deliveryId}
        AND i2.status <> 'sent'
    )`;
    const candidates = await tx
      .select({ id: pgSchema.outboundDeliveryItemsPostgres.id })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .innerJoin(
        pgSchema.outboundDeliveriesPostgres,
        eq(
          pgSchema.outboundDeliveryItemsPostgres.deliveryId,
          pgSchema.outboundDeliveriesPostgres.id,
        ),
      )
      .innerJoin(
        pgSchema.conversationsPostgres,
        and(
          eq(
            pgSchema.outboundDeliveriesPostgres.conversationId,
            pgSchema.conversationsPostgres.id,
          ),
          eq(
            pgSchema.outboundDeliveriesPostgres.appId,
            pgSchema.conversationsPostgres.appId,
          ),
        ),
      )
      .where(
        and(
          duePending,
          input.appId
            ? eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId)
            : undefined,
          input.profileId
            ? eq(pgSchema.outboundDeliveriesPostgres.profileId, input.profileId)
            : undefined,
          or(
            isNull(pgSchema.outboundDeliveriesPostgres.threadId),
            sql`EXISTS (
              SELECT 1
              FROM ${pgSchema.conversationThreadsPostgres} AS t
              WHERE t.id = ${pgSchema.outboundDeliveriesPostgres.threadId}
                AND t.app_id = ${pgSchema.outboundDeliveriesPostgres.appId}
                AND t.conversation_id = ${pgSchema.outboundDeliveriesPostgres.conversationId}
            )`,
          ),
          sql`${pgSchema.outboundDeliveryItemsPostgres.ordinal} = ${nextUnsentOrdinalExpr}`,
        ),
      )
      .orderBy(
        asc(pgSchema.outboundDeliveryItemsPostgres.nextAttemptAt),
        asc(pgSchema.outboundDeliveryItemsPostgres.createdAt),
        asc(pgSchema.outboundDeliveryItemsPostgres.ordinal),
      )
      .limit(input.limit)
      .for('update', {
        of: pgSchema.outboundDeliveryItemsPostgres,
        skipLocked: true,
      });
    if (candidates.length === 0) return [];

    const leaseUntil = computeLeaseExpiry(input.now, input.leaseMs);
    const claimedRows: ItemRow[] = [];
    for (const candidate of candidates) {
      const claimToken = createClaimToken();
      const rows = await tx
        .update(pgSchema.outboundDeliveryItemsPostgres)
        .set({
          status: 'claimed',
          attemptCount: sql`${pgSchema.outboundDeliveryItemsPostgres.attemptCount} + 1`,
          claimToken,
          claimOwner: input.claimerId,
          claimExpiresAt: leaseUntil,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, candidate.id),
            and(
              eq(pgSchema.outboundDeliveryItemsPostgres.status, 'pending'),
              lte(
                pgSchema.outboundDeliveryItemsPostgres.nextAttemptAt,
                input.now,
              ),
            ),
          ),
        )
        .returning();
      if (rows[0]) claimedRows.push(rows[0]);
    }
    if (claimedRows.length === 0) return [];

    const deliveryIds = [...new Set(claimedRows.map((row) => row.deliveryId))];
    await tx
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({
        status: 'claimed',
        updatedAt: input.now,
      })
      .where(inArray(pgSchema.outboundDeliveriesPostgres.id, deliveryIds));
    const deliveries = await tx
      .select()
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(inArray(pgSchema.outboundDeliveriesPostgres.id, deliveryIds));
    const answers = await tx
      .select()
      .from(pgSchema.outboundDeliveryFinalAnswersPostgres)
      .where(
        inArray(
          pgSchema.outboundDeliveryFinalAnswersPostgres.deliveryId,
          deliveryIds,
        ),
      );
    const deliveryById = new Map(deliveries.map((row) => [row.id, row]));
    const answerByDeliveryId = new Map(
      answers.map((row) => [row.deliveryId, row]),
    );
    return claimedRows
      .map((row) => {
        const delivery = deliveryById.get(row.deliveryId);
        if (!delivery) return null;
        return {
          delivery: mapDelivery(delivery),
          item: mapItem(row),
          finalAnswer: answerByDeliveryId.get(row.deliveryId)
            ? mapFinalAnswer(answerByDeliveryId.get(row.deliveryId)!)
            : null,
        } satisfies ClaimedOutboundDeliveryItem;
      })
      .filter((row): row is ClaimedOutboundDeliveryItem => row !== null);
  });
}

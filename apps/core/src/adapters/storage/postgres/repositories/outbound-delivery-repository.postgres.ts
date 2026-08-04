import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  OutboundDeliveryIdempotencyConflictError,
  type ClaimedOutboundDeliveryItem,
  type OutboundDelivery,
  type OutboundDeliveryFinalAnswer,
  type OutboundDeliveryId,
  type OutboundDeliveryItem,
  type OutboundDeliveryItemId,
  type OutboundDeliveryReceipt,
  type OutboundDeliveryReceiptId,
  type OutboundDeliveryResolvedDestination,
} from '../../../../domain/outbound-delivery/outbound-delivery.js';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import type { OutboundDeliveryRepository } from '../../../../domain/ports/repositories.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  canonicalProviderThreadForIds,
  type CanonicalDb,
  type CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { claimDueOutboundDeliveryItems } from './outbound-delivery-repository.postgres.claims.js';
import { resolveOutboundDeliveryDestination } from './outbound-delivery-repository.postgres.destinations.js';
import {
  buildPartialDeliveryError,
  computeLeaseExpiry,
  computeRetryBackoffMs,
  encodeJson,
  isUniqueViolation,
  mapDelivery,
  mapReceipt,
  normalizeRetryTail,
  recomputeOutboundDeliveryStatus,
  timestampsRepresentSameInstant,
  type ReceiptRow,
} from './outbound-delivery-repository.postgres.helpers.js';
export class PostgresOutboundDeliveryRepository implements OutboundDeliveryRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly deps: {
      now?: () => string;
      createClaimToken?: () => string;
    } = {},
  ) {}
  async enqueueDelivery(input: {
    delivery: OutboundDelivery;
    finalAnswer: OutboundDeliveryFinalAnswer;
    items: OutboundDeliveryItem[];
  }): Promise<{ created: boolean; delivery: OutboundDelivery }> {
    return this.db.transaction(async (tx) => {
      await this.ensureCanonicalProviderThread(tx, input.delivery);
      await this.assertOwnedConversationThread(tx, {
        appId: input.delivery.appId,
        conversationId: input.delivery.conversationId,
        threadId: input.delivery.threadId,
      });
      const existing = await this.findByAppAndIdempotency(tx, {
        appId: input.delivery.appId,
        idempotencyKey: input.delivery.idempotencyKey,
      });
      if (existing) {
        this.assertSameIdempotencyFingerprint(existing, input.delivery);
        return { created: false, delivery: existing };
      }
      try {
        const inserted = await tx
          .insert(pgSchema.outboundDeliveriesPostgres)
          .values({
            id: input.delivery.id,
            appId: input.delivery.appId,
            conversationId: input.delivery.conversationId,
            threadId: input.delivery.threadId ?? null,
            agentId: input.delivery.agentId ?? null,
            runId: input.delivery.runId ?? null,
            profileId: input.delivery.profileId,
            idempotencyKey: input.delivery.idempotencyKey,
            idempotencyFingerprint: input.delivery.idempotencyFingerprint,
            status: input.delivery.status,
            settledAt: input.delivery.settledAt ?? null,
            lastError: input.delivery.lastError ?? null,
            createdAt: input.delivery.createdAt,
            updatedAt: input.delivery.updatedAt,
          })
          .returning();
        const deliveryRow = inserted[0];
        if (!deliveryRow) {
          throw new Error('Failed to insert outbound delivery row.');
        }
        await tx
          .insert(pgSchema.outboundDeliveryFinalAnswersPostgres)
          .values({
            deliveryId: input.finalAnswer.deliveryId,
            canonicalText: input.finalAnswer.canonicalText,
            segmentCount: input.finalAnswer.segmentCount,
            createdAt: input.finalAnswer.createdAt,
            updatedAt: input.finalAnswer.updatedAt,
          })
          .onConflictDoUpdate({
            target: pgSchema.outboundDeliveryFinalAnswersPostgres.deliveryId,
            set: {
              canonicalText: input.finalAnswer.canonicalText,
              segmentCount: input.finalAnswer.segmentCount,
              updatedAt: input.finalAnswer.updatedAt,
            },
          });
        if (input.items.length > 0) {
          await tx.insert(pgSchema.outboundDeliveryItemsPostgres).values(
            input.items.map((item) => ({
              id: item.id,
              deliveryId: item.deliveryId,
              ordinal: item.ordinal,
              canonicalText: item.canonicalText,
              providerPayloadJson:
                item.providerPayload === undefined
                  ? null
                  : encodeJson(
                      sanitizeRetryTailProviderPayload(item.providerPayload),
                    ),
              status: item.status,
              attemptCount: item.attemptCount,
              claimToken: item.claimToken ?? null,
              claimOwner: null,
              claimExpiresAt: item.claimExpiresAt ?? null,
              nextAttemptAt: item.nextAttemptAt,
              sentAt: item.sentAt ?? null,
              failedAt: item.failedAt ?? null,
              lastError: item.lastError ?? null,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })),
          );
        }
        return { created: true, delivery: mapDelivery(deliveryRow) };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const retry = await this.findByAppAndIdempotency(tx, {
          appId: input.delivery.appId,
          idempotencyKey: input.delivery.idempotencyKey,
        });
        if (retry) {
          this.assertSameIdempotencyFingerprint(retry, input.delivery);
          return { created: false, delivery: retry };
        }
        throw err;
      }
    });
  }
  async getDelivery(id: OutboundDeliveryId): Promise<OutboundDelivery | null> {
    return this.getDeliveryById(this.db, id);
  }
  async claimDueDeliveryItems(input: {
    appId?: OutboundDelivery['appId'];
    profileId?: string;
    now: string;
    claimerId: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedOutboundDeliveryItem[]> {
    return claimDueOutboundDeliveryItems(this.db, input, () =>
      this.createClaimToken(),
    );
  }
  async resolveDeliveryDestination(input: {
    appId: OutboundDelivery['appId'];
    conversationId: OutboundDelivery['conversationId'];
    threadId?: OutboundDelivery['threadId'];
  }): Promise<OutboundDeliveryResolvedDestination | null> {
    return resolveOutboundDeliveryDestination(this.db, input);
  }
  async markDeliveryItemSent(input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    receipt: OutboundDeliveryReceipt;
  }): Promise<{ applied: boolean; delivery: OutboundDelivery | null }> {
    return this.db.transaction(async (tx) => {
      const itemRows = await tx
        .select()
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.deliveryId,
              input.deliveryId,
            ),
          ),
        )
        .limit(1)
        .for('update');
      const itemRow = itemRows[0];
      if (!itemRow) return { applied: false, delivery: null };
      if (
        input.receipt.deliveryId !== input.deliveryId ||
        input.receipt.itemId !== input.itemId
      ) {
        return { applied: false, delivery: null };
      }
      if (itemRow.status === 'sent') {
        const replay = await this.getReceiptByItemAndIdempotency(tx, {
          itemId: input.itemId,
          idempotencyKey: input.receipt.idempotencyKey,
        });
        if (!replay || !this.isExactReceiptReplay(replay, input.receipt)) {
          return { applied: false, delivery: null };
        }
        const delivery = await this.getDeliveryById(tx, input.deliveryId);
        return { applied: true, delivery };
      }
      if (
        itemRow.status !== 'claimed' ||
        itemRow.claimToken !== input.claimToken
      ) {
        return { applied: false, delivery: null };
      }
      const providerPayloadJson =
        input.receipt.providerPayload === undefined
          ? null
          : encodeJson(
              sanitizeRetryTailProviderPayload(input.receipt.providerPayload),
            );
      await tx
        .insert(pgSchema.outboundDeliveryReceiptsPostgres)
        .values({
          id: input.receipt.id,
          deliveryId: input.receipt.deliveryId,
          itemId: input.receipt.itemId,
          idempotencyKey: input.receipt.idempotencyKey,
          providerMessageId: input.receipt.providerMessageId ?? null,
          providerPayloadJson,
          sentAt: input.receipt.sentAt,
          createdAt: input.receipt.createdAt,
        })
        .onConflictDoNothing({
          target: [
            pgSchema.outboundDeliveryReceiptsPostgres.itemId,
            pgSchema.outboundDeliveryReceiptsPostgres.idempotencyKey,
          ],
        });
      const stored = await this.getReceiptByItemAndIdempotency(tx, {
        itemId: input.itemId,
        idempotencyKey: input.receipt.idempotencyKey,
      });
      if (!stored || !this.isExactReceiptReplay(stored, input.receipt)) {
        return { applied: false, delivery: null };
      }
      const updated = await tx
        .update(pgSchema.outboundDeliveryItemsPostgres)
        .set({
          status: 'sent',
          sentAt: input.receipt.sentAt,
          failedAt: null,
          lastError: null,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
          updatedAt: input.receipt.sentAt,
        })
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.deliveryId,
              input.deliveryId,
            ),
            eq(pgSchema.outboundDeliveryItemsPostgres.status, 'claimed'),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.claimToken,
              input.claimToken,
            ),
          ),
        )
        .returning();
      if (!updated[0]) return { applied: false, delivery: null };
      const delivery = await this.recomputeDeliveryStatus(tx, {
        deliveryId: input.deliveryId,
        now: input.receipt.sentAt,
      });
      return { applied: true, delivery };
    });
  }
  async markDeliveryItemFailed(input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    error: string;
    failedAt: string;
    maxAttempts: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  }): Promise<{ applied: boolean; delivery: OutboundDelivery | null }> {
    return this.db.transaction(async (tx) => {
      const itemRows = await tx
        .select()
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.deliveryId,
              input.deliveryId,
            ),
          ),
        )
        .limit(1)
        .for('update');
      const itemRow = itemRows[0];
      if (!itemRow) return { applied: false, delivery: null };
      if (
        itemRow.status === 'failed' &&
        itemRow.lastError === input.error &&
        timestampsRepresentSameInstant(itemRow.failedAt, input.failedAt)
      ) {
        const delivery = await this.getDeliveryById(tx, input.deliveryId);
        return { applied: true, delivery };
      }
      if (
        itemRow.status !== 'claimed' ||
        itemRow.claimToken !== input.claimToken
      ) {
        return { applied: false, delivery: null };
      }
      const retryable = itemRow.attemptCount < input.maxAttempts;
      const nextAttemptAt = retryable
        ? computeLeaseExpiry(
            input.failedAt,
            computeRetryBackoffMs({
              attemptCount: itemRow.attemptCount,
              baseDelayMs: input.retryBaseDelayMs,
              maxDelayMs: input.retryMaxDelayMs,
            }),
          )
        : input.failedAt;
      const updated = await tx
        .update(pgSchema.outboundDeliveryItemsPostgres)
        .set({
          status: retryable ? 'pending' : 'failed',
          failedAt: retryable ? null : input.failedAt,
          lastError: input.error,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
          nextAttemptAt,
          updatedAt: input.failedAt,
        })
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.deliveryId,
              input.deliveryId,
            ),
            eq(pgSchema.outboundDeliveryItemsPostgres.status, 'claimed'),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.claimToken,
              input.claimToken,
            ),
          ),
        )
        .returning();
      if (!updated[0]) return { applied: false, delivery: null };
      const delivery = await this.recomputeDeliveryStatus(tx, {
        deliveryId: input.deliveryId,
        now: input.failedAt,
      });
      return { applied: true, delivery };
    });
  }
  async markDeliveryItemPartiallyDelivered(input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    error: string;
    partialAt: string;
    deliveredParts?: number;
    totalParts?: number;
    retryTail?: {
      canonicalText: string;
      providerPayload?: unknown;
    };
  }): Promise<{ applied: boolean; delivery: OutboundDelivery | null }> {
    return this.db.transaction(async (tx) => {
      const itemRows = await tx
        .select()
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.deliveryId,
              input.deliveryId,
            ),
          ),
        )
        .limit(1)
        .for('update');
      const itemRow = itemRows[0];
      if (!itemRow) return { applied: false, delivery: null };

      const partialError = buildPartialDeliveryError({
        error: input.error,
        deliveredParts: input.deliveredParts,
        totalParts: input.totalParts,
      });
      const retryTail = normalizeRetryTail(input.retryTail);
      if (
        itemRow.status === 'partially_delivered' &&
        itemRow.lastError === partialError &&
        timestampsRepresentSameInstant(itemRow.failedAt, input.partialAt) &&
        !retryTail
      ) {
        const delivery = await this.getDeliveryById(tx, input.deliveryId);
        return { applied: true, delivery };
      }
      if (
        itemRow.status !== 'claimed' ||
        itemRow.claimToken !== input.claimToken
      ) {
        return { applied: false, delivery: null };
      }

      const updated = await tx
        .update(pgSchema.outboundDeliveryItemsPostgres)
        .set({
          status: retryTail ? 'pending' : 'partially_delivered',
          canonicalText: retryTail?.canonicalText ?? itemRow.canonicalText,
          providerPayloadJson:
            retryTail === undefined
              ? itemRow.providerPayloadJson
              : retryTail.providerPayload === undefined
                ? null
                : encodeJson(
                    sanitizeRetryTailProviderPayload(retryTail.providerPayload),
                  ),
          failedAt: retryTail ? null : input.partialAt,
          lastError: partialError,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
          nextAttemptAt: input.partialAt,
          updatedAt: input.partialAt,
        })
        .where(
          and(
            eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.deliveryId,
              input.deliveryId,
            ),
            eq(pgSchema.outboundDeliveryItemsPostgres.status, 'claimed'),
            eq(
              pgSchema.outboundDeliveryItemsPostgres.claimToken,
              input.claimToken,
            ),
          ),
        )
        .returning();
      if (!updated[0]) return { applied: false, delivery: null };
      const delivery = await this.recomputeDeliveryStatus(tx, {
        deliveryId: input.deliveryId,
        now: input.partialAt,
      });
      return { applied: true, delivery };
    });
  }
  async listReceiptsForItem(
    itemId: OutboundDeliveryItemId,
  ): Promise<OutboundDeliveryReceipt[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.outboundDeliveryReceiptsPostgres)
      .where(eq(pgSchema.outboundDeliveryReceiptsPostgres.itemId, itemId))
      .orderBy(asc(pgSchema.outboundDeliveryReceiptsPostgres.createdAt));
    return rows.map(mapReceipt);
  }
  async getReceipt(
    id: OutboundDeliveryReceiptId,
  ): Promise<OutboundDeliveryReceipt | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.outboundDeliveryReceiptsPostgres)
      .where(eq(pgSchema.outboundDeliveryReceiptsPostgres.id, id))
      .limit(1);
    return rows[0] ? mapReceipt(rows[0]) : null;
  }
  private now(): string {
    return this.deps.now?.() ?? currentIso();
  }
  private createClaimToken(): string {
    return this.deps.createClaimToken?.() ?? `claim:${randomUUID()}`;
  }
  private async findByAppAndIdempotency(
    db: CanonicalExecutor,
    input: { appId: OutboundDelivery['appId']; idempotencyKey: string },
  ): Promise<OutboundDelivery | null> {
    const rows = await db
      .select()
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(
        and(
          eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId),
          eq(
            pgSchema.outboundDeliveriesPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? mapDelivery(rows[0]) : null;
  }
  private assertSameIdempotencyFingerprint(
    existing: OutboundDelivery,
    requested: OutboundDelivery,
  ): void {
    if (existing.idempotencyFingerprint === requested.idempotencyFingerprint) {
      return;
    }
    throw new OutboundDeliveryIdempotencyConflictError(
      `Conflict for app ${requested.appId} idempotency key ${requested.idempotencyKey}`,
    );
  }
  private async ensureCanonicalProviderThread(
    tx: CanonicalExecutor,
    delivery: OutboundDelivery,
  ): Promise<void> {
    if (!delivery.threadId) return;
    const thread = canonicalProviderThreadForDelivery({
      appId: delivery.appId,
      conversationId: delivery.conversationId,
      threadId: delivery.threadId,
    });
    if (!thread) return;
    await tx
      .insert(pgSchema.conversationThreadsPostgres)
      .values({
        id: thread.id,
        appId: thread.appId,
        conversationId: thread.conversationId,
        externalRefJson: thread.externalRefJson,
        updatedAt: currentIso(),
      })
      .onConflictDoNothing();
  }
  private async getDeliveryById(
    db: CanonicalExecutor,
    id: OutboundDeliveryId,
  ): Promise<OutboundDelivery | null> {
    const rows = await db
      .select()
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, id))
      .limit(1);
    return rows[0] ? mapDelivery(rows[0]) : null;
  }
  private async assertOwnedConversationThread(
    tx: CanonicalExecutor,
    input: {
      appId: OutboundDelivery['appId'];
      conversationId: OutboundDelivery['conversationId'];
      threadId?: OutboundDelivery['threadId'];
    },
  ): Promise<void> {
    if (input.threadId) {
      const rows = await tx
        .select({
          conversationId: pgSchema.conversationsPostgres.id,
          threadId: pgSchema.conversationThreadsPostgres.id,
        })
        .from(pgSchema.conversationsPostgres)
        .leftJoin(
          pgSchema.conversationThreadsPostgres,
          and(
            eq(pgSchema.conversationThreadsPostgres.id, input.threadId),
            eq(pgSchema.conversationThreadsPostgres.appId, input.appId),
            eq(
              pgSchema.conversationThreadsPostgres.conversationId,
              pgSchema.conversationsPostgres.id,
            ),
          ),
        )
        .where(
          and(
            eq(pgSchema.conversationsPostgres.id, input.conversationId),
            eq(pgSchema.conversationsPostgres.appId, input.appId),
          ),
        )
        .limit(1);
      if (!rows[0]?.threadId) {
        throw new Error(
          'Outbound delivery conversation/thread is not owned by the target app.',
        );
      }
      return;
    }
    const rows = await tx
      .select({ id: pgSchema.conversationsPostgres.id })
      .from(pgSchema.conversationsPostgres)
      .where(
        and(
          eq(pgSchema.conversationsPostgres.id, input.conversationId),
          eq(pgSchema.conversationsPostgres.appId, input.appId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw new Error(
        'Outbound delivery conversation is not owned by the target app.',
      );
    }
  }
  private async getReceiptByItemAndIdempotency(
    db: CanonicalExecutor,
    input: { itemId: OutboundDeliveryItemId; idempotencyKey: string },
  ): Promise<ReceiptRow | null> {
    const rows = await db
      .select()
      .from(pgSchema.outboundDeliveryReceiptsPostgres)
      .where(
        and(
          eq(pgSchema.outboundDeliveryReceiptsPostgres.itemId, input.itemId),
          eq(
            pgSchema.outboundDeliveryReceiptsPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  private isExactReceiptReplay(
    row: ReceiptRow,
    receipt: OutboundDeliveryReceipt,
  ): boolean {
    const providerPayloadJson =
      receipt.providerPayload === undefined
        ? null
        : encodeJson(sanitizeRetryTailProviderPayload(receipt.providerPayload));
    return (
      row.id === receipt.id &&
      row.deliveryId === receipt.deliveryId &&
      row.itemId === receipt.itemId &&
      row.idempotencyKey === receipt.idempotencyKey &&
      row.providerMessageId === (receipt.providerMessageId ?? null) &&
      row.providerPayloadJson === providerPayloadJson &&
      timestampsRepresentSameInstant(row.sentAt, receipt.sentAt) &&
      timestampsRepresentSameInstant(row.createdAt, receipt.createdAt)
    );
  }
  private async recomputeDeliveryStatus(
    tx: CanonicalExecutor,
    input: { deliveryId: OutboundDeliveryId; now?: string },
  ): Promise<OutboundDelivery | null> {
    return recomputeOutboundDeliveryStatus(tx, {
      ...input,
      fallbackNow: () => this.now(),
      getDeliveryById: (db, id) => this.getDeliveryById(db, id),
    });
  }
}

export function canonicalProviderThreadForDelivery(input: {
  appId: OutboundDelivery['appId'];
  conversationId: OutboundDelivery['conversationId'];
  threadId?: OutboundDelivery['threadId'];
}): {
  id: string;
  appId: OutboundDelivery['appId'];
  conversationId: OutboundDelivery['conversationId'];
  externalRefJson: string;
} | null {
  return canonicalProviderThreadForIds({
    appId: input.appId,
    conversationId: input.conversationId,
    threadId: input.threadId,
  });
}

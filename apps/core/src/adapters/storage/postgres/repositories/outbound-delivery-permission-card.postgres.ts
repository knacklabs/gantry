import { and, eq, isNull, sql } from 'drizzle-orm';

import { SETUP_REQUIRED_PAUSE_REASON } from '../../../../domain/jobs/jobs.js';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import type {
  OutboundDelivery,
  OutboundDeliveryId,
  OutboundDeliveryItemId,
  OutboundDeliveryPermissionPromptLocator,
  OutboundDeliveryReceipt,
} from '../../../../domain/outbound-delivery/outbound-delivery.js';
import type { PermissionCardMessageView } from '../../../../domain/permission-card.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import {
  encodeJson,
  mapDelivery,
  recomputeOutboundDeliveryStatus,
  timestampsRepresentSameInstant,
  type ReceiptRow,
} from './outbound-delivery-repository.postgres.helpers.js';

export async function getSetupPermissionPromptForDispatch(
  db: CanonicalExecutor,
  input: {
    appId: OutboundDelivery['appId'];
    promptId: string;
    now: string;
  },
): Promise<PermissionCardMessageView | null> {
  const [prompt] = await db
    .select()
    .from(pgSchema.permissionPromptsPostgres)
    .where(
      and(
        eq(pgSchema.permissionPromptsPostgres.id, input.promptId),
        eq(pgSchema.permissionPromptsPostgres.appId, input.appId),
        eq(pgSchema.permissionPromptsPostgres.settlementState, 'open'),
      ),
    )
    .limit(1);
  if (
    !prompt?.jobId ||
    !prompt.setupFingerprint ||
    !prompt.providerAliases[0]
  ) {
    return null;
  }
  const [member] = await db
    .select({ id: pgSchema.pendingInteractionsPostgres.id })
    .from(pgSchema.pendingInteractionsPostgres)
    .where(
      and(
        eq(pgSchema.pendingInteractionsPostgres.envelopeId, input.promptId),
        eq(pgSchema.pendingInteractionsPostgres.appId, input.appId),
        eq(pgSchema.pendingInteractionsPostgres.kind, 'permission'),
        eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
        // Member validity is judged by DATABASE wall-clock time -
        // clock_timestamp(), not now(): now() freezes at transaction start
        // and lock waits can outlive the lease (review R7/R8).
        sql`${pgSchema.pendingInteractionsPostgres.expiresAt} > clock_timestamp()`,
      ),
    )
    .limit(1);
  if (!member) return null;
  const [job] = await db
    .select({
      status: pgSchema.canonicalJobsPostgres.status,
      pauseReason: pgSchema.canonicalJobsPostgres.pauseReason,
      setupState: pgSchema.canonicalJobsPostgres.setupState,
    })
    .from(pgSchema.canonicalJobsPostgres)
    .where(
      and(
        eq(pgSchema.canonicalJobsPostgres.id, prompt.jobId),
        eq(pgSchema.canonicalJobsPostgres.appId, input.appId),
      ),
    )
    .limit(1);
  const setupState = job?.setupState as
    | { state?: unknown; fingerprint?: unknown }
    | null
    | undefined;
  if (
    !job ||
    job.status !== 'paused' ||
    job.pauseReason !== SETUP_REQUIRED_PAUSE_REASON ||
    setupState?.state === 'ready' ||
    setupState?.fingerprint !== prompt.setupFingerprint
  ) {
    return null;
  }
  return {
    request: prompt.renderedRequestJson as PermissionCardMessageView['request'],
    providerAlias: prompt.providerAliases[0],
    ...(prompt.fullViewJson
      ? {
          fullView: prompt.fullViewJson as NonNullable<
            PermissionCardMessageView['fullView']
          >,
        }
      : {}),
  };
}

export async function beginDeliveryItemSend(
  db: CanonicalDb,
  input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    promptId: string;
    claimToken: string;
    begunAt: string;
  },
): Promise<'begun' | 'lease_lost' | 'prompt_closed'> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        and(
          eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
          eq(
            pgSchema.outboundDeliveryItemsPostgres.deliveryId,
            input.deliveryId,
          ),
          eq(
            pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
            input.promptId,
          ),
          eq(pgSchema.outboundDeliveryItemsPostgres.status, 'claimed'),
          eq(
            pgSchema.outboundDeliveryItemsPostgres.claimToken,
            input.claimToken,
          ),
          // Lease validity is judged by DATABASE wall-clock time - a stale
          // caller timestamp must not revive an expired claim, and now()
          // would freeze at transaction start across lock waits (R6/R8).
          sql`${pgSchema.outboundDeliveryItemsPostgres.claimExpiresAt} > clock_timestamp()`,
          isNull(pgSchema.outboundDeliveryItemsPostgres.sendBegunAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!item) return 'lease_lost';
    const [delivery] = await tx
      .select({ appId: pgSchema.outboundDeliveriesPostgres.appId })
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, input.deliveryId))
      .limit(1);
    if (!delivery) return 'lease_lost';
    // Lock the prompt row so a concurrent cancellation serializes against
    // the checkpoint: cancel-before-lock wins (we bail), cancel-after waits
    // until send_begun_at is stamped and takes the post-checkpoint path.
    const [lockedPrompt] = await tx
      .select({
        settlementState: pgSchema.permissionPromptsPostgres.settlementState,
      })
      .from(pgSchema.permissionPromptsPostgres)
      .where(eq(pgSchema.permissionPromptsPostgres.id, input.promptId))
      .for('update')
      .limit(1);
    if (!lockedPrompt || lockedPrompt.settlementState !== 'open') {
      return 'prompt_closed';
    }
    if (
      !(await getSetupPermissionPromptForDispatch(tx, {
        appId: delivery.appId as OutboundDelivery['appId'],
        promptId: input.promptId,
        now: input.begunAt,
      }))
    ) {
      return 'prompt_closed';
    }
    const updated = await tx
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({ sendBegunAt: input.begunAt, updatedAt: input.begunAt })
      .where(
        and(
          eq(pgSchema.outboundDeliveryItemsPostgres.id, input.itemId),
          eq(pgSchema.outboundDeliveryItemsPostgres.status, 'claimed'),
          eq(
            pgSchema.outboundDeliveryItemsPostgres.claimToken,
            input.claimToken,
          ),
          // Re-check the lease AFTER every lock wait: the prompt lock can
          // block past claim_expires_at, and the earlier read's predicate
          // would not notice (review R8).
          sql`${pgSchema.outboundDeliveryItemsPostgres.claimExpiresAt} > clock_timestamp()`,
          isNull(pgSchema.outboundDeliveryItemsPostgres.sendBegunAt),
        ),
      )
      .returning({ id: pgSchema.outboundDeliveryItemsPostgres.id });
    return updated[0] ? 'begun' : 'lease_lost';
  });
}

export async function markDeliveryItemSent(
  db: CanonicalDb,
  input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    receipt: OutboundDeliveryReceipt;
    permissionPromptLocator?: OutboundDeliveryPermissionPromptLocator;
  },
): Promise<{ applied: boolean; delivery: OutboundDelivery | null }> {
  return db.transaction(async (tx) => {
    const [itemRow] = await tx
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
    if (
      !itemRow ||
      input.receipt.deliveryId !== input.deliveryId ||
      input.receipt.itemId !== input.itemId
    ) {
      return { applied: false, delivery: null };
    }
    if (itemRow.status === 'sent') {
      const replay = await getReceiptByItemAndIdempotency(tx, {
        itemId: input.itemId,
        idempotencyKey: input.receipt.idempotencyKey,
      });
      if (
        !replay ||
        !isExactReceiptReplay(replay, input.receipt) ||
        !(await attachPermissionPromptLocator(tx, {
          itemRow,
          locator: input.permissionPromptLocator,
          now: input.receipt.sentAt,
        }))
      ) {
        return { applied: false, delivery: null };
      }
      return {
        applied: true,
        delivery: await getDeliveryById(tx, input.deliveryId),
      };
    }
    if (
      itemRow.status !== 'claimed' ||
      itemRow.claimToken !== input.claimToken
    ) {
      return { applied: false, delivery: null };
    }
    await insertReceipt(tx, input.receipt);
    const stored = await getReceiptByItemAndIdempotency(tx, {
      itemId: input.itemId,
      idempotencyKey: input.receipt.idempotencyKey,
    });
    if (!stored || !isExactReceiptReplay(stored, input.receipt)) {
      return { applied: false, delivery: null };
    }
    if (
      !(await attachPermissionPromptLocator(tx, {
        itemRow,
        locator: input.permissionPromptLocator,
        now: input.receipt.sentAt,
      }))
    ) {
      throw new Error(
        'Permission prompt locator settlement conflicted with the sent receipt.',
      );
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
    if (!updated[0]) {
      throw new Error(
        'Outbound delivery item settlement lost its locked claim.',
      );
    }
    const delivery = await recomputeOutboundDeliveryStatus(tx, {
      deliveryId: input.deliveryId,
      fallbackNow: () => input.receipt.sentAt,
      getDeliveryById,
    });
    return { applied: true, delivery };
  });
}

async function insertReceipt(
  tx: CanonicalExecutor,
  receipt: OutboundDeliveryReceipt,
): Promise<void> {
  const providerPayloadJson =
    receipt.providerPayload === undefined
      ? null
      : encodeJson(sanitizeRetryTailProviderPayload(receipt.providerPayload));
  await tx
    .insert(pgSchema.outboundDeliveryReceiptsPostgres)
    .values({
      id: receipt.id,
      deliveryId: receipt.deliveryId,
      itemId: receipt.itemId,
      idempotencyKey: receipt.idempotencyKey,
      providerMessageId: receipt.providerMessageId ?? null,
      providerPayloadJson,
      sentAt: receipt.sentAt,
      createdAt: receipt.createdAt,
    })
    .onConflictDoNothing({
      target: [
        pgSchema.outboundDeliveryReceiptsPostgres.itemId,
        pgSchema.outboundDeliveryReceiptsPostgres.idempotencyKey,
      ],
    });
}

async function attachPermissionPromptLocator(
  tx: CanonicalExecutor,
  input: {
    itemRow: typeof pgSchema.outboundDeliveryItemsPostgres.$inferSelect;
    locator?: OutboundDeliveryPermissionPromptLocator;
    now: string;
  },
): Promise<boolean> {
  const promptId = input.itemRow.permissionPromptId;
  if (!promptId) return input.locator === undefined;
  if (!input.locator) return false;
  const [prompt] = await tx
    .select()
    .from(pgSchema.permissionPromptsPostgres)
    .where(eq(pgSchema.permissionPromptsPostgres.id, promptId))
    .for('update')
    .limit(1);
  if (!prompt) return false;
  const existing = [
    prompt.externalPromptProvider,
    prompt.externalPromptConversationId,
    prompt.externalPromptMessageId,
    prompt.externalPromptThreadId,
  ];
  if (existing.some((value) => value !== null)) {
    return (
      prompt.externalPromptProvider === input.locator.provider &&
      prompt.externalPromptConversationId === input.locator.conversationId &&
      prompt.externalPromptMessageId === input.locator.messageId &&
      prompt.externalPromptThreadId === (input.locator.threadId ?? null)
    );
  }
  const updated = await tx
    .update(pgSchema.permissionPromptsPostgres)
    .set({
      externalPromptProvider: input.locator.provider,
      externalPromptConversationId: input.locator.conversationId,
      externalPromptMessageId: input.locator.messageId,
      externalPromptThreadId: input.locator.threadId ?? null,
      updatedAt: input.now,
    })
    .where(eq(pgSchema.permissionPromptsPostgres.id, promptId))
    .returning({ id: pgSchema.permissionPromptsPostgres.id });
  return Boolean(updated[0]);
}

async function getReceiptByItemAndIdempotency(
  db: CanonicalExecutor,
  input: { itemId: OutboundDeliveryItemId; idempotencyKey: string },
): Promise<ReceiptRow | null> {
  const [row] = await db
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
  return row ?? null;
}

function isExactReceiptReplay(
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

async function getDeliveryById(
  db: CanonicalExecutor,
  id: OutboundDeliveryId,
): Promise<OutboundDelivery | null> {
  const [row] = await db
    .select()
    .from(pgSchema.outboundDeliveriesPostgres)
    .where(eq(pgSchema.outboundDeliveriesPostgres.id, id))
    .limit(1);
  return row ? mapDelivery(row) : null;
}

// Claim-fenced cancellation settle: a rejected pre-send revalidation makes
// the item TERMINAL cancelled (never the failed/retry path) and recomputes
// the parent status.
export async function markDeliveryItemCancelled(
  db: CanonicalDb,
  input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    reason: Record<string, unknown>;
    cancelledAt: string;
  },
): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'cancelled',
        cancellationReasonJson: input.reason,
        claimToken: null,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: input.cancelledAt,
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
          // A send that already began must resolve through settlement or
          // the ambiguity rules - cancellation only lands pre-checkpoint.
          isNull(pgSchema.outboundDeliveryItemsPostgres.sendBegunAt),
        ),
      )
      .returning({ id: pgSchema.outboundDeliveryItemsPostgres.id });
    if (!updated[0]) return { applied: false };
    await recomputeOutboundDeliveryStatus(tx, {
      deliveryId: input.deliveryId,
      now: input.cancelledAt,
      fallbackNow: () => input.cancelledAt,
      getDeliveryById,
    });
    return { applied: true };
  });
}

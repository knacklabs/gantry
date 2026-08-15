import { and, eq, inArray, isNull } from 'drizzle-orm';

import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export function deleteCanonicalJobWithSetupCancellation(
  db: CanonicalDb,
  jobId: string,
): Promise<void> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ id: pgSchema.canonicalJobsPostgres.id })
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, jobId))
      .for('update')
      .limit(1);
    if (!job) return;

    const cancelledAt = nowIso();
    const cancellationReason = { code: 'job_deleted', job_id: jobId };
    const prompts = await tx
      .select({
        id: pgSchema.permissionPromptsPostgres.id,
        settlementState: pgSchema.permissionPromptsPostgres.settlementState,
      })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        and(
          eq(pgSchema.permissionPromptsPostgres.jobId, jobId),
          inArray(pgSchema.permissionPromptsPostgres.settlementState, [
            'open',
            'claimed',
          ]),
        ),
      )
      .for('update');
    const promptIds = prompts.map((prompt) => prompt.id);

    if (promptIds.length > 0) {
      // Lock EVERY active item first - locking only items whose checkpoint
      // is already stamped would let beginSend stamp an unlocked item
      // between this read and the cancellation update (review R1).
      const activeItems = await tx
        .select({
          id: pgSchema.outboundDeliveryItemsPostgres.id,
          sendBegunAt: pgSchema.outboundDeliveryItemsPostgres.sendBegunAt,
        })
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(
          and(
            inArray(
              pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
              promptIds,
            ),
            inArray(pgSchema.outboundDeliveryItemsPostgres.status, [
              'pending',
              'claimed',
            ]),
          ),
        )
        .for('update');
      if (activeItems.some((item) => item.sendBegunAt !== null)) {
        throw new Error(
          `Cannot delete job ${jobId}: setup prompt delivery send has already begun`,
        );
      }

      const cancelledItems = await tx
        .update(pgSchema.outboundDeliveryItemsPostgres)
        .set({
          status: 'cancelled',
          cancellationReasonJson: cancellationReason,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
          updatedAt: cancelledAt,
        })
        .where(
          and(
            inArray(
              pgSchema.outboundDeliveryItemsPostgres.id,
              activeItems.map((item) => item.id),
            ),
            isNull(pgSchema.outboundDeliveryItemsPostgres.sendBegunAt),
          ),
        )
        .returning({
          deliveryId: pgSchema.outboundDeliveryItemsPostgres.deliveryId,
        });
      const deliveryIds = [
        ...new Set(cancelledItems.map((item) => item.deliveryId)),
      ];
      if (deliveryIds.length > 0) {
        await tx
          .update(pgSchema.outboundDeliveriesPostgres)
          .set({
            status: 'cancelled',
            cancellationReasonJson: cancellationReason,
            settledAt: cancelledAt,
            updatedAt: cancelledAt,
          })
          .where(inArray(pgSchema.outboundDeliveriesPostgres.id, deliveryIds));
      }

      await tx
        .update(pgSchema.pendingInteractionsPostgres)
        .set({
          status: 'cancelled',
          resolutionJson: cancellationReason,
          approverRef: null,
          resolvedAt: cancelledAt,
        })
        .where(
          and(
            inArray(pgSchema.pendingInteractionsPostgres.envelopeId, promptIds),
            eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
          ),
        );
      // Job deletion is AUTHORITATIVE target invalidation: open prompts
      // cancel, but a CLAIMED prompt supersedes under the claim lock so an
      // in-flight callback observes supersession before applying authority
      // (the one exception to open-only sweeps; review R1).
      const openIds = prompts
        .filter((prompt) => prompt.settlementState === 'open')
        .map((prompt) => prompt.id);
      const claimedIds = prompts
        .filter((prompt) => prompt.settlementState === 'claimed')
        .map((prompt) => prompt.id);
      if (openIds.length > 0) {
        await tx
          .update(pgSchema.permissionPromptsPostgres)
          .set({
            settlementState: 'cancelled',
            settledAt: cancelledAt,
            updatedAt: cancelledAt,
          })
          .where(inArray(pgSchema.permissionPromptsPostgres.id, openIds));
      }
      if (claimedIds.length > 0) {
        await tx
          .update(pgSchema.permissionPromptsPostgres)
          .set({
            settlementState: 'superseded',
            settledAt: cancelledAt,
            updatedAt: cancelledAt,
          })
          .where(inArray(pgSchema.permissionPromptsPostgres.id, claimedIds));
      }
    }

    await tx
      .delete(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, jobId));
  });
}

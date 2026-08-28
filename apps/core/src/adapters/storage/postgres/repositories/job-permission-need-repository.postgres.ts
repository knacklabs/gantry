import { isDeepStrictEqual } from 'node:util';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type {
  JobPermissionCardDeliveryOutcome,
  JobPermissionCardRecord,
  JobPermissionCardRevision,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
} from '../../../../domain/ports/job-permission-durability.js';
import {
  jobPermissionCardActions,
  jobPermissionCardText,
} from '../../../../domain/job-permission-card-actions.js';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import { IPC_INTERACTION_RETENTION_TTL_MS } from '../../../../shared/ipc-interaction-lifetime.js';
import { sha256Hex } from '../../../../shared/stable-hash.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import {
  readJobPermissionCard,
  readJobPermissionNeed,
} from './worker-coordination-interaction-repository.postgres.js';

export class JobPermissionNeedRepositoryPostgres {
  constructor(private readonly db: CanonicalDb) {}

  async mutateJobPermissionState<T>(input: {
    appId: string;
    jobId: string;
    initialCard: JobPermissionCardRecord;
    mutate: (state: JobPermissionDurabilityState) => {
      state: JobPermissionDurabilityState;
      result: T;
    };
  }): Promise<T> {
    const table = pgSchema.pendingInteractionsPostgres;
    return this.db.transaction(async (tx) => {
      await tx
        .insert(table)
        .values({
          id: input.initialCard.id,
          appId: input.appId,
          runId: null,
          envelopeId: null,
          memberIndex: null,
          sourceAgentFolder: input.initialCard.sourceAgentFolder || null,
          requestId: input.jobId,
          runLeaseToken: null,
          runLeaseFencingVersion: null,
          kind: 'job_permission_card',
          status: 'pending',
          payloadJson: input.initialCard,
          callbackRouteJson: null,
          idempotencyKey: input.initialCard.id,
          approverRef: null,
          resolutionJson: null,
          createdAt: input.initialCard.createdAt,
          expiresAt: '9999-12-31T23:59:59.999Z',
          resolvedAt: null,
        })
        .onConflictDoNothing({ target: table.idempotencyKey });
      const [cardRow] = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.appId, input.appId),
            eq(table.kind, 'job_permission_card'),
            eq(table.idempotencyKey, input.initialCard.id),
          ),
        )
        .for('update')
        .limit(1);
      if (!cardRow) throw new Error('Job permission card row is unavailable.');
      const needRows = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.appId, input.appId),
            eq(table.kind, 'job_permission_need'),
            sql`${table.payloadJson}->>'jobId' = ${input.jobId}`,
          ),
        )
        .for('update');
      const card = readJobPermissionCard(cardRow.payloadJson);
      const needs = needRows.map((row) =>
        readJobPermissionNeed(row.payloadJson),
      );
      if (!card || needs.some((need) => !need)) {
        throw new Error('Stored job permission state is malformed.');
      }
      const existingIds = new Set(
        needs.map((need) => (need as JobPermissionNeedRecord).id),
      );
      const mutation = input.mutate(
        structuredClone({
          card,
          needs: needs as JobPermissionNeedRecord[],
        }),
      );
      assertJobPermissionState(mutation.state, input, card);
      await extendJobPermissionWaiterExpiry(tx, mutation.state);
      const newRevisions = mutation.state.card.revisions.slice(
        card.revisions.length,
      );
      if (
        [...existingIds].some(
          (id) => !mutation.state.needs.some((need) => need.id === id),
        )
      ) {
        throw new Error('Job permission need rows cannot be deleted.');
      }
      for (const revision of newRevisions) {
        await cancelSupersededPendingCardDeliveries(
          tx,
          mutation.state.card,
          revision,
        );
        await insertJobPermissionCardDelivery(
          tx,
          mutation.state.card,
          revision,
        );
      }
      await tx
        .update(table)
        .set({
          payloadJson: mutation.state.card,
          sourceAgentFolder:
            mutation.state.card.sourceAgentFolder || cardRow.sourceAgentFolder,
        })
        .where(eq(table.id, cardRow.id));
      for (const need of mutation.state.needs) {
        await tx
          .insert(table)
          .values({
            id: need.id,
            appId: input.appId,
            runId: null,
            envelopeId: null,
            memberIndex: null,
            sourceAgentFolder: need.sourceAgentFolder,
            requestId: need.id,
            runLeaseToken: null,
            runLeaseFencingVersion: null,
            kind: 'job_permission_need',
            status: 'pending',
            payloadJson: need,
            callbackRouteJson: null,
            idempotencyKey: need.id,
            approverRef: need.decidedBy,
            resolutionJson: null,
            createdAt: need.createdAt,
            expiresAt: '9999-12-31T23:59:59.999Z',
            resolvedAt: null,
          })
          .onConflictDoUpdate({
            target: table.idempotencyKey,
            set: {
              payloadJson: need,
              sourceAgentFolder: need.sourceAgentFolder,
              approverRef: need.decidedBy,
            },
            setWhere: and(
              eq(table.appId, input.appId),
              eq(table.kind, 'job_permission_need'),
            ),
          });
      }
      return mutation.result;
    });
  }

  async listJobPermissionNeedsForReconciliation(
    input: {
      limit?: number;
    } = {},
  ): Promise<JobPermissionNeedRecord[]> {
    const table = pgSchema.pendingInteractionsPostgres;
    const rows = await this.db
      .select({ payload: table.payloadJson })
      .from(table)
      .where(
        and(
          eq(table.kind, 'job_permission_need'),
          eq(table.status, 'pending'),
          sql`(${table.payloadJson}->>'state' IN ('asking', 'approved_pending_apply', 'denied_pending_delivery', 'handoff_pending') OR (${table.payloadJson}->>'state' = 'handed_off' AND ${table.payloadJson}->>'grant' = 'once'))`,
        ),
      )
      .orderBy(asc(table.createdAt))
      .limit(Math.max(1, Math.min(500, input.limit ?? 100)));
    return rows.map((row) => readJobPermissionNeed(row.payload));
  }

  async listJobPermissionCardsForReconciliation(
    input: { limit?: number } = {},
  ): Promise<JobPermissionCardRecord[]> {
    const table = pgSchema.pendingInteractionsPostgres;
    const rows = await this.db
      .select({ payload: table.payloadJson })
      .from(table)
      .where(
        and(eq(table.kind, 'job_permission_card'), eq(table.status, 'pending')),
      )
      .orderBy(asc(table.createdAt))
      .limit(Math.max(1, Math.min(500, input.limit ?? 100)));
    return rows
      .map((row) => readJobPermissionCard(row.payload))
      .filter((card): card is JobPermissionCardRecord => Boolean(card))
      .filter((card) =>
        card.revisionDeliveries.some((delivery) =>
          ['pending', 'ambiguous'].includes(delivery.status),
        ),
      );
  }

  async getJobPermissionState(input: {
    appId: string;
    jobId: string;
  }): Promise<JobPermissionDurabilityState | null> {
    const table = pgSchema.pendingInteractionsPostgres;
    const rows = await this.db
      .select({ kind: table.kind, payload: table.payloadJson })
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          inArray(table.kind, ['job_permission_card', 'job_permission_need']),
          sql`${table.payloadJson}->>'jobId' = ${input.jobId}`,
        ),
      );
    const cardRow = rows.find((row) => row.kind === 'job_permission_card');
    const card = cardRow ? readJobPermissionCard(cardRow.payload) : null;
    if (!card) return null;
    return {
      card,
      needs: rows
        .filter((row) => row.kind === 'job_permission_need')
        .map((row) => readJobPermissionNeed(row.payload)),
    };
  }

  async findJobPermissionStateByCallbackKey(input: {
    callbackKey: string;
  }): Promise<JobPermissionDurabilityState | null> {
    const rows = await this.db
      .select({
        appId: pgSchema.pendingInteractionsPostgres.appId,
        payload: pgSchema.pendingInteractionsPostgres.payloadJson,
      })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        and(
          eq(pgSchema.pendingInteractionsPostgres.kind, 'job_permission_card'),
          eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
          sql`${pgSchema.pendingInteractionsPostgres.payloadJson}->>'callbackKey' = ${input.callbackKey}`,
        ),
      )
      .limit(2);
    if (rows.length !== 1) return null;
    const card = readJobPermissionCard(rows[0]!.payload);
    if (!card) return null;
    return this.getJobPermissionState({
      appId: rows[0]!.appId,
      jobId: card.jobId,
    });
  }

  async getJobPermissionCardDeliveryOutcome(input: {
    appId: string;
    deliveryId: string;
  }): Promise<JobPermissionCardDeliveryOutcome | null> {
    const [delivery] = await this.db
      .select({
        status: pgSchema.outboundDeliveriesPostgres.status,
        lastError: pgSchema.outboundDeliveriesPostgres.lastError,
        cancellationReason:
          pgSchema.outboundDeliveriesPostgres.cancellationReasonJson,
      })
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(
        and(
          eq(pgSchema.outboundDeliveriesPostgres.id, input.deliveryId),
          eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId),
        ),
      )
      .limit(1);
    if (!delivery) return null;
    if (delivery.status === 'pending' || delivery.status === 'claimed') {
      return { status: 'pending' };
    }
    if (delivery.status === 'sent') {
      const [receipt] = await this.db
        .select({
          providerMessageId:
            pgSchema.outboundDeliveryReceiptsPostgres.providerMessageId,
          providerPayloadJson:
            pgSchema.outboundDeliveryReceiptsPostgres.providerPayloadJson,
          sentAt: pgSchema.outboundDeliveryReceiptsPostgres.sentAt,
        })
        .from(pgSchema.outboundDeliveryReceiptsPostgres)
        .where(
          eq(
            pgSchema.outboundDeliveryReceiptsPostgres.deliveryId,
            input.deliveryId,
          ),
        )
        .orderBy(asc(pgSchema.outboundDeliveryReceiptsPostgres.sentAt))
        .limit(1);
      if (receipt?.providerMessageId) {
        const retireDelivery = jobPermissionCardRetireDeliveryFromReceipt(
          receipt.providerPayloadJson,
        );
        return {
          status: 'delivered',
          provider: null,
          providerMessageId: receipt.providerMessageId,
          deliveredAt: receipt.sentAt,
          ...(retireDelivery ? { retireDelivery } : {}),
        };
      }
      return {
        status: 'ambiguous',
        reason: 'Card delivery settled without a provider message id.',
      };
    }
    const reason =
      delivery.lastError ||
      JSON.stringify(delivery.cancellationReason ?? {}) ||
      'Card delivery did not complete.';
    return delivery.status === 'partially_delivered'
      ? { status: 'ambiguous', reason }
      : delivery.status === 'cancelled'
        ? { status: 'cancelled', reason }
        : { status: 'exhausted', reason };
  }
}

async function extendJobPermissionWaiterExpiry(
  tx: CanonicalExecutor,
  state: JobPermissionDurabilityState,
): Promise<void> {
  const table = pgSchema.pendingInteractionsPostgres;
  for (const need of state.needs) {
    const anchor =
      need.decidedAt ??
      (need.state === 'handoff_pending' ? need.updatedAt : need.waitStartedAt);
    if (!anchor) continue;
    const anchorMs = Date.parse(anchor);
    if (!Number.isFinite(anchorMs)) {
      throw new Error('Job permission waiter expiry anchor is malformed.');
    }
    const requestIds = [
      ...new Set(need.waiters.map((waiter) => waiter.requestId)),
    ];
    if (requestIds.length === 0) continue;
    const expiresAt = new Date(
      anchorMs + IPC_INTERACTION_RETENTION_TTL_MS,
    ).toISOString();
    await tx
      .update(table)
      .set({ expiresAt: sql`GREATEST(${table.expiresAt}, ${expiresAt})` })
      .where(
        and(
          eq(table.appId, need.appId),
          eq(table.kind, 'permission'),
          eq(table.status, 'pending'),
          eq(table.sourceAgentFolder, need.sourceAgentFolder),
          inArray(table.requestId, requestIds),
        ),
      );
  }
}

async function insertJobPermissionCardDelivery(
  tx: CanonicalExecutor,
  card: JobPermissionCardRecord,
  revision: JobPermissionCardRevision,
): Promise<void> {
  if (!card.conversationId) {
    throw new Error('Job permission card delivery route is unavailable.');
  }
  const [conversation] = await tx
    .select({ id: pgSchema.conversationsPostgres.id })
    .from(pgSchema.conversationsPostgres)
    .where(
      and(
        eq(pgSchema.conversationsPostgres.id, card.conversationId),
        eq(pgSchema.conversationsPostgres.appId, card.appId),
      ),
    )
    .limit(1);
  if (!conversation) {
    throw new Error('Job permission card route belongs to another app.');
  }
  const canonicalText = jobPermissionCardText(card.jobId, revision);
  const providerPayload = jobPermissionCardProviderPayload(card, revision);
  const idempotencyKey = `job_permission_card:${card.id}:${revision.revision}`;
  const idempotencyFingerprint = sha256Hex(
    JSON.stringify([
      card.appId,
      card.conversationId,
      card.threadId,
      revision.operation,
      canonicalText,
      providerPayload.jobPermissionCard,
    ]),
  );
  await tx.insert(pgSchema.outboundDeliveriesPostgres).values({
    id: revision.deliveryId,
    appId: card.appId,
    conversationId: card.conversationId,
    threadId: card.threadId,
    agentId: card.agentId,
    runId: null,
    profileId: 'job_permission_card',
    idempotencyKey,
    idempotencyFingerprint,
    status: 'pending',
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt,
  });
  await tx.insert(pgSchema.outboundDeliveryFinalAnswersPostgres).values({
    deliveryId: revision.deliveryId,
    canonicalText,
    segmentCount: 1,
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt,
  });
  await tx.insert(pgSchema.outboundDeliveryItemsPostgres).values({
    id: revision.deliveryItemId,
    deliveryId: revision.deliveryId,
    permissionPromptId: null,
    generation: revision.revision,
    ordinal: 0,
    canonicalText,
    providerPayloadJson: JSON.stringify(providerPayload),
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: revision.createdAt,
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt,
  });
}

function jobPermissionCardProviderPayload(
  card: JobPermissionCardRecord,
  revision: JobPermissionCardRevision,
) {
  return {
    jobPermissionCard: {
      jobId: card.jobId,
      callbackKey: card.callbackKey,
      revision: revision.revision,
      operation: revision.operation,
      providerMessageId: card.currentProviderMessageId,
      rows: revision.rows,
      batchNeedIds: revision.batchNeedIds,
      hiddenRowCount: revision.hiddenRowCount,
      retireOutcome: revision.retireOutcome,
      retiredRows: revision.retiredRows,
      retireDelivery: revision.retireDelivery,
      actions: jobPermissionCardActions(card.callbackKey, revision),
    },
  };
}

function jobPermissionCardRetireDeliveryFromReceipt(
  providerPayloadJson: string | null,
) {
  if (!providerPayloadJson) return undefined;
  try {
    return sanitizeRetryTailProviderPayload(JSON.parse(providerPayloadJson))
      ?.jobPermissionCardRetireDelivery;
  } catch {
    return undefined;
  }
}

async function cancelSupersededPendingCardDeliveries(
  tx: CanonicalExecutor,
  card: JobPermissionCardRecord,
  revision: JobPermissionCardRevision,
): Promise<void> {
  const supersededDeliveryId = card.revisions
    .filter((candidate) => candidate.revision < revision.revision)
    .at(-1)?.deliveryId;
  if (!supersededDeliveryId) return;
  const cancelledItems = await tx
    .update(pgSchema.outboundDeliveryItemsPostgres)
    .set({
      status: 'cancelled',
      cancellationReasonJson: {
        code: 'job_permission_card_revision_superseded',
        revision: revision.revision,
      },
      updatedAt: revision.createdAt,
    })
    .where(
      and(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.deliveryId,
          supersededDeliveryId,
        ),
        eq(pgSchema.outboundDeliveryItemsPostgres.status, 'pending'),
      ),
    )
    .returning({
      deliveryId: pgSchema.outboundDeliveryItemsPostgres.deliveryId,
    });
  const cancelledDeliveryIds = [
    ...new Set(cancelledItems.map((item) => item.deliveryId)),
  ];
  if (cancelledDeliveryIds.length === 0) return;
  await tx
    .update(pgSchema.outboundDeliveriesPostgres)
    .set({
      status: 'cancelled',
      settledAt: revision.createdAt,
      cancellationReasonJson: {
        code: 'job_permission_card_revision_superseded',
        revision: revision.revision,
      },
      updatedAt: revision.createdAt,
    })
    .where(
      and(
        inArray(pgSchema.outboundDeliveriesPostgres.id, cancelledDeliveryIds),
        eq(pgSchema.outboundDeliveriesPostgres.status, 'pending'),
      ),
    );
}

function assertJobPermissionState(
  state: JobPermissionDurabilityState,
  scope: { appId: string; jobId: string },
  previousCard: JobPermissionCardRecord,
): void {
  if (
    state.card.appId !== scope.appId ||
    state.card.jobId !== scope.jobId ||
    state.card.id !== previousCard.id ||
    state.card.callbackKey !== previousCard.callbackKey ||
    state.card.conversationId !== previousCard.conversationId ||
    state.card.threadId !== previousCard.threadId ||
    state.card.agentId !== previousCard.agentId ||
    // Recorded revisions stay immutable except for the first retire-delivery
    // acknowledgement; a marker already recorded can never change or clear.
    !isDeepStrictEqual(
      state.card.revisions
        .slice(0, previousCard.revisions.length)
        .map((revision, index) =>
          previousCard.revisions[index]?.retireDelivery
            ? revision
            : { ...revision, retireDelivery: undefined },
        ),
      previousCard.revisions.map((revision) =>
        revision.retireDelivery
          ? revision
          : { ...revision, retireDelivery: undefined },
      ),
    ) ||
    !Number.isInteger(state.card.pageOffset) ||
    state.card.pageOffset < 0 ||
    !Number.isInteger(state.card.fullScopePageOffset) ||
    state.card.fullScopePageOffset < 0 ||
    state.card.revisionDeliveries.length !== state.card.revisions.length ||
    new Set(state.card.revisionDeliveries.map((delivery) => delivery.revision))
      .size !== state.card.revisionDeliveries.length ||
    state.card.revisionDeliveries.some((delivery) => {
      const revision = state.card.revisions.find(
        (candidate) => candidate.revision === delivery.revision,
      );
      return !revision || revision.deliveryId !== delivery.deliveryId;
    }) ||
    previousCard.revisionDeliveries.some((previous) => {
      const current = state.card.revisionDeliveries.find(
        (delivery) => delivery.revision === previous.revision,
      );
      return !current || current.deliveryId !== previous.deliveryId;
    }) ||
    new Set(state.card.rerunBarriers.map((barrier) => barrier.priorRunId))
      .size !== state.card.rerunBarriers.length ||
    state.card.rerunBarriers.some(
      (barrier) =>
        !barrier.priorRunId ||
        barrier.requiredNeeds.length === 0 ||
        new Set(
          barrier.requiredNeeds.map(
            (required) => `${required.needId}:${required.askingEpoch}`,
          ),
        ).size !== barrier.requiredNeeds.length ||
        barrier.requiredNeeds.some(
          (required) =>
            !state.needs.some(
              (need) =>
                need.id === required.needId &&
                (barrier.enqueuedAt ||
                  need.askingEpoch === required.askingEpoch),
            ),
        ),
    ) ||
    new Set(state.needs.map((need) => need.id)).size !== state.needs.length ||
    state.needs.some(
      (need) =>
        need.appId !== scope.appId ||
        need.jobId !== scope.jobId ||
        (need.approvedGrantAtoms?.some(
          (atom) => !need.renderedGrantAtoms.includes(atom),
        ) ??
          false),
    )
  ) {
    throw new Error('Job permission mutation crossed its durable scope.');
  }
  const newRevisions = state.card.revisions.slice(
    previousCard.revisions.length,
  );
  for (const [index, revision] of newRevisions.entries()) {
    const expectedRevision = previousCard.revision + index + 1;
    const rowKeys = revision.rows.map(
      (row) => `${row.needId}:${row.askingEpoch}`,
    );
    if (
      revision.revision !== expectedRevision ||
      !Number.isInteger(revision.deliveryAttempt) ||
      revision.deliveryAttempt < 1 ||
      revision.deliveryAttempt > 4 ||
      new Set(rowKeys).size !== rowKeys.length ||
      new Set(
        revision.representedNeeds.map(
          (represented) => `${represented.needId}:${represented.askingEpoch}`,
        ),
      ).size !== revision.representedNeeds.length ||
      revision.representedNeeds.some(
        (represented) =>
          !state.needs.some(
            (need) =>
              need.id === represented.needId &&
              need.askingEpoch === represented.askingEpoch,
          ),
      ) ||
      revision.rows.some((row) => {
        const need = state.needs.find(
          (candidate) =>
            candidate.id === row.needId &&
            candidate.askingEpoch === row.askingEpoch,
        );
        return (
          !need ||
          JSON.stringify(row.renderedGrantAtoms) !==
            JSON.stringify(need.renderedGrantAtoms) ||
          row.visibleGrantAtoms.some(
            (atom) => !row.renderedGrantAtoms.includes(atom),
          ) ||
          !Number.isInteger(row.scopePageStart) ||
          row.scopePageStart < 0 ||
          JSON.stringify(row.visibleGrantAtoms) !==
            JSON.stringify(
              row.renderedGrantAtoms.slice(
                row.scopePageStart,
                row.scopePageStart + row.visibleGrantAtoms.length,
              ),
            ) ||
          (row.scopeFullyVisible &&
            row.scopePageStart + row.visibleGrantAtoms.length <
              row.renderedGrantAtoms.length) ||
          (row.action === 'show_scope') !== !row.scopeFullyVisible
        );
      }) ||
      revision.batchNeedIds.some(
        (needId) =>
          !revision.rows.some(
            (row) =>
              row.needId === needId &&
              row.action === 'allow_and_continue' &&
              row.scopeFullyVisible &&
              row.actionEnabled,
          ),
      ) ||
      !Number.isInteger(revision.pageStart) ||
      revision.pageStart < 0
    ) {
      throw new Error('Job permission card revision is not snapshot-bound.');
    }
  }
  if (state.card.revision !== (state.card.revisions.at(-1)?.revision ?? 0)) {
    throw new Error('Job permission card revision is not contiguous.');
  }
}

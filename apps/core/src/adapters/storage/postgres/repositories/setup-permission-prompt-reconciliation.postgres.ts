import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import {
  jobSetupCardDeliveryEventPayload,
  type JobSetupCardDeliveryOutcome,
} from '../../../../domain/events/job-setup-card-delivery.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';

export interface SetupPermissionPromptReconcileResult {
  terminalDeliveries: number;
  expiredPrompts: number;
}

// Bounds one reconcile pass: enough to drain a large backlog across a few
// ticks without letting a single tick run unbounded.
const MAX_RECONCILE_BATCHES = 10;

export async function reconcileSetupPermissionPrompts(
  db: CanonicalDb,
  runtimeEvents: PostgresRuntimeEventRepository,
  input: { now: string; limit?: number },
): Promise<SetupPermissionPromptReconcileResult> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 500));
  let terminalDeliveries = 0;
  // Drain in stable oldest-first batches: a replenishing head must not
  // starve older unreconciled rows.
  for (let batch = 0; batch < MAX_RECONCILE_BATCHES; batch += 1) {
    const terminalRows = await db
      .select({ id: pgSchema.outboundDeliveryItemsPostgres.id })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .innerJoin(
        pgSchema.outboundDeliveriesPostgres,
        eq(
          pgSchema.outboundDeliveriesPostgres.id,
          pgSchema.outboundDeliveryItemsPostgres.deliveryId,
        ),
      )
      .where(
        and(
          isNotNull(pgSchema.outboundDeliveryItemsPostgres.permissionPromptId),
          inArray(pgSchema.outboundDeliveryItemsPostgres.status, [
            'sent',
            'failed',
            'partially_delivered',
            'cancelled',
          ]),
          sql`NOT EXISTS (
            SELECT 1 FROM ${pgSchema.runtimeEventsPostgres} event
            WHERE event.app_id = ${pgSchema.outboundDeliveriesPostgres.appId}
              AND event.idempotency_key = 'card_delivery_terminal:' || ${pgSchema.outboundDeliveryItemsPostgres.permissionPromptId} || ':' || ${pgSchema.outboundDeliveryItemsPostgres.generation}::text
          )`,
        ),
      )
      .orderBy(asc(pgSchema.outboundDeliveryItemsPostgres.id))
      .limit(limit);
    for (const row of terminalRows) {
      if (
        await reconcileTerminalDelivery(db, runtimeEvents, row.id, input.now)
      ) {
        terminalDeliveries += 1;
      }
    }
    if (terminalRows.length < limit) break;
  }

  const expiryRows = await db
    .selectDistinct({ id: pgSchema.permissionPromptsPostgres.id })
    .from(pgSchema.permissionPromptsPostgres)
    .innerJoin(
      pgSchema.pendingInteractionsPostgres,
      eq(
        pgSchema.pendingInteractionsPostgres.envelopeId,
        pgSchema.permissionPromptsPostgres.id,
      ),
    )
    .where(
      and(
        eq(pgSchema.permissionPromptsPostgres.settlementState, 'open'),
        eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
        lte(pgSchema.pendingInteractionsPostgres.expiresAt, input.now),
        isNotNull(pgSchema.permissionPromptsPostgres.jobId),
        isNotNull(pgSchema.permissionPromptsPostgres.setupFingerprint),
      ),
    )
    .limit(limit);
  let expiredPrompts = 0;
  for (const row of expiryRows) {
    if (await expirePrompt(db, runtimeEvents, row.id, input.now)) {
      expiredPrompts += 1;
    }
  }
  return { terminalDeliveries, expiredPrompts };
}

async function reconcileTerminalDelivery(
  db: CanonicalDb,
  runtimeEvents: PostgresRuntimeEventRepository,
  itemId: string,
  now: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [peeked] = await tx
      .select({
        promptId: pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
      })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(eq(pgSchema.outboundDeliveryItemsPostgres.id, itemId))
      .limit(1);
    if (!peeked?.promptId) return false;
    // Lock ORDER matches expiry (prompt before item) so the two reconcile
    // paths cannot deadlock, and the settlement state read under this lock
    // is the one the projection decision uses (review R2).
    const [lockedPrompt] = await tx
      .select({
        settlementState: pgSchema.permissionPromptsPostgres.settlementState,
      })
      .from(pgSchema.permissionPromptsPostgres)
      .where(eq(pgSchema.permissionPromptsPostgres.id, peeked.promptId))
      .for('update')
      .limit(1);
    if (!lockedPrompt) return false;
    const [item] = await tx
      .select()
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(eq(pgSchema.outboundDeliveryItemsPostgres.id, itemId))
      .for('update')
      .limit(1);
    if (
      !item?.permissionPromptId ||
      !['sent', 'failed', 'partially_delivered', 'cancelled'].includes(
        item.status,
      )
    ) {
      return false;
    }
    const [context] = await tx
      .select({
        appId: pgSchema.outboundDeliveriesPostgres.appId,
        conversationId: pgSchema.outboundDeliveriesPostgres.conversationId,
        threadId: pgSchema.outboundDeliveriesPostgres.threadId,
        jobId: pgSchema.permissionPromptsPostgres.jobId,
        setupFingerprint: pgSchema.permissionPromptsPostgres.setupFingerprint,
        promptProvider:
          pgSchema.permissionPromptsPostgres.externalPromptProvider,
        provider: pgSchema.providerAccountsPostgres.providerId,
      })
      .from(pgSchema.outboundDeliveriesPostgres)
      .innerJoin(
        pgSchema.permissionPromptsPostgres,
        eq(pgSchema.permissionPromptsPostgres.id, item.permissionPromptId),
      )
      .innerJoin(
        pgSchema.conversationsPostgres,
        eq(
          pgSchema.conversationsPostgres.id,
          pgSchema.outboundDeliveriesPostgres.conversationId,
        ),
      )
      .innerJoin(
        pgSchema.providerAccountsPostgres,
        eq(
          pgSchema.providerAccountsPostgres.id,
          pgSchema.conversationsPostgres.providerAccountId,
        ),
      )
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, item.deliveryId))
      .limit(1);
    if (!context?.jobId || !context.setupFingerprint) return false;
    const outcome = deliveryOutcomeForItemStatus(item.status);
    const appended =
      await runtimeEvents.appendRuntimeEventWithOutcomeAndExecutor(tx, {
        appId: context.appId as never,
        jobId: context.jobId as never,
        conversationId: context.conversationId as never,
        threadId: context.threadId ? (context.threadId as never) : undefined,
        eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_CARD_DELIVERY,
        actor: 'scheduler',
        idempotencyKey: terminalDeliveryEventKey(
          item.permissionPromptId,
          item.generation,
        ),
        payload: jobSetupCardDeliveryEventPayload({
          prompt_id: item.permissionPromptId,
          generation: item.generation,
          job_id: context.jobId,
          setup_fingerprint: context.setupFingerprint,
          outcome,
          attempt: item.attemptCount,
          provider: context.promptProvider ?? context.provider,
          ...(item.lastError ? { detail: item.lastError } : {}),
        }),
        createdAt: now as never,
      });
    if (appended.inserted) {
      // The truthful event always appends, but the JOB projection only
      // follows a prompt that is still the live one: expiry/supersession
      // keeps the fingerprint, so a delayed 'delivered' from a retired
      // prompt would otherwise restore notified_fingerprint and undo
      // expiry's clear (review R1; settlement read under the prompt lock,
      // review R2). Delivery-driven cancellation still settles the prompt
      // itself (self-guarded on open).
      const [newest] = await tx
        .select({
          generation: sql<number>`max(${pgSchema.outboundDeliveryItemsPostgres.generation})`,
        })
        .from(pgSchema.outboundDeliveryItemsPostgres)
        .where(
          eq(
            pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
            item.permissionPromptId,
          ),
        );
      // Only the prompt's NEWEST generation may mutate the job: an old
      // generation reconciling late must not clear or restore
      // notified_fingerprint over a newer generation's outcome (review R3).
      const isCurrentGeneration =
        Number(newest?.generation ?? item.generation) === item.generation;
      if (
        outcome === 'cancelled' ||
        (isCurrentGeneration &&
          (lockedPrompt.settlementState === 'open' ||
            lockedPrompt.settlementState === 'claimed'))
      ) {
        await projectDeliveryOutcome(tx, {
          promptId: item.permissionPromptId,
          jobId: context.jobId,
          setupFingerprint: context.setupFingerprint,
          outcome,
          now,
        });
      }
    }
    return true;
  });
}

async function expirePrompt(
  db: CanonicalDb,
  runtimeEvents: PostgresRuntimeEventRepository,
  promptId: string,
  now: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [prompt] = await tx
      .select()
      .from(pgSchema.permissionPromptsPostgres)
      .where(eq(pgSchema.permissionPromptsPostgres.id, promptId))
      .for('update')
      .limit(1);
    if (
      !prompt?.jobId ||
      !prompt.setupFingerprint ||
      prompt.settlementState !== 'open'
    ) {
      return false;
    }
    const expiredMembers = await tx
      .update(pgSchema.pendingInteractionsPostgres)
      .set({ status: 'expired', resolvedAt: now })
      .where(
        and(
          eq(pgSchema.pendingInteractionsPostgres.envelopeId, promptId),
          eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
          lte(pgSchema.pendingInteractionsPostgres.expiresAt, now),
        ),
      )
      .returning({ id: pgSchema.pendingInteractionsPostgres.id });
    if (expiredMembers.length === 0) return false;
    await tx
      .update(pgSchema.permissionPromptsPostgres)
      .set({ settlementState: 'expired', settledAt: now, updatedAt: now })
      .where(eq(pgSchema.permissionPromptsPostgres.id, promptId));

    const cancelledItems = await tx
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'cancelled',
        cancellationReasonJson: { code: 'prompt_expired' },
        claimToken: null,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(
            pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
            promptId,
          ),
          inArray(pgSchema.outboundDeliveryItemsPostgres.status, [
            'pending',
            'claimed',
          ]),
          sql`${pgSchema.outboundDeliveryItemsPostgres.sendBegunAt} IS NULL`,
        ),
      )
      .returning({
        deliveryId: pgSchema.outboundDeliveryItemsPostgres.deliveryId,
        generation: pgSchema.outboundDeliveryItemsPostgres.generation,
        attempt: pgSchema.outboundDeliveryItemsPostgres.attemptCount,
      });
    if (cancelledItems.length > 0) {
      await tx
        .update(pgSchema.outboundDeliveriesPostgres)
        .set({
          status: 'cancelled',
          cancellationReasonJson: { code: 'prompt_expired' },
          settledAt: now,
          updatedAt: now,
        })
        .where(
          inArray(
            pgSchema.outboundDeliveriesPostgres.id,
            cancelledItems.map((item) => item.deliveryId),
          ),
        );
    }
    const provider = await latestPromptProvider(tx, promptId);
    for (const cancelled of cancelledItems) {
      await runtimeEvents.appendRuntimeEventWithOutcomeAndExecutor(tx, {
        appId: prompt.appId as never,
        jobId: prompt.jobId as never,
        eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_CARD_DELIVERY,
        actor: 'scheduler',
        idempotencyKey: terminalDeliveryEventKey(
          promptId,
          cancelled.generation,
        ),
        payload: jobSetupCardDeliveryEventPayload({
          prompt_id: promptId,
          generation: cancelled.generation,
          job_id: prompt.jobId,
          setup_fingerprint: prompt.setupFingerprint,
          outcome: 'cancelled',
          attempt: cancelled.attempt,
          provider: prompt.externalPromptProvider ?? provider.provider,
          detail: 'The approval prompt expired before delivery completed.',
        }),
        createdAt: now as never,
      });
    }
    await runtimeEvents.appendRuntimeEventWithExecutor(tx, {
      appId: prompt.appId as never,
      jobId: prompt.jobId as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_CARD_DELIVERY,
      actor: 'scheduler',
      idempotencyKey: `card_delivery_expired:${promptId}`,
      payload: jobSetupCardDeliveryEventPayload({
        prompt_id: promptId,
        generation: provider.generation,
        job_id: prompt.jobId,
        setup_fingerprint: prompt.setupFingerprint,
        outcome: 'expired',
        attempt: provider.attempt,
        provider: prompt.externalPromptProvider ?? provider.provider,
      }),
      createdAt: now as never,
    });
    await projectDeliveryOutcome(tx, {
      promptId,
      jobId: prompt.jobId,
      setupFingerprint: prompt.setupFingerprint,
      outcome: 'expired',
      now,
    });
    return true;
  });
}

async function latestPromptProvider(
  tx: CanonicalExecutor,
  promptId: string,
): Promise<{ provider: string; generation: number; attempt: number }> {
  const [row] = await tx
    .select({
      provider: pgSchema.providerAccountsPostgres.providerId,
      generation: pgSchema.outboundDeliveryItemsPostgres.generation,
      attempt: pgSchema.outboundDeliveryItemsPostgres.attemptCount,
    })
    .from(pgSchema.outboundDeliveryItemsPostgres)
    .innerJoin(
      pgSchema.outboundDeliveriesPostgres,
      eq(
        pgSchema.outboundDeliveriesPostgres.id,
        pgSchema.outboundDeliveryItemsPostgres.deliveryId,
      ),
    )
    .innerJoin(
      pgSchema.conversationsPostgres,
      eq(
        pgSchema.conversationsPostgres.id,
        pgSchema.outboundDeliveriesPostgres.conversationId,
      ),
    )
    .innerJoin(
      pgSchema.providerAccountsPostgres,
      eq(
        pgSchema.providerAccountsPostgres.id,
        pgSchema.conversationsPostgres.providerAccountId,
      ),
    )
    .where(
      eq(pgSchema.outboundDeliveryItemsPostgres.permissionPromptId, promptId),
    )
    .orderBy(desc(pgSchema.outboundDeliveryItemsPostgres.generation))
    .limit(1);
  if (!row) throw new Error('Setup permission prompt delivery is missing.');
  return row;
}

async function projectDeliveryOutcome(
  tx: CanonicalExecutor,
  input: {
    promptId: string;
    jobId: string;
    setupFingerprint: string;
    outcome: JobSetupCardDeliveryOutcome;
    now: string;
  },
): Promise<void> {
  if (input.outcome === 'cancelled') {
    // Deliberately OPEN-only: a claimed prompt means a human holds the
    // decision, and the lifecycle contract forbids clobbering an acquired
    // claim (claim-retry protocol resolves it via the pending list). The
    // Axis-A cancelled event stays truthful about the delivery either way.
    const cancelled = await tx
      .update(pgSchema.permissionPromptsPostgres)
      .set({
        settlementState: 'cancelled',
        settledAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(pgSchema.permissionPromptsPostgres.id, input.promptId),
          eq(pgSchema.permissionPromptsPostgres.settlementState, 'open'),
        ),
      )
      .returning({ id: pgSchema.permissionPromptsPostgres.id });
    if (cancelled.length > 0) {
      await tx
        .update(pgSchema.pendingInteractionsPostgres)
        .set({ status: 'cancelled', resolvedAt: input.now })
        .where(
          and(
            eq(pgSchema.pendingInteractionsPostgres.envelopeId, input.promptId),
            eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
          ),
        );
    }
    return;
  }
  if (!['delivered', 'exhausted', 'expired'].includes(input.outcome)) return;
  const jobs = pgSchema.canonicalJobsPostgres;
  const setupState =
    input.outcome === 'delivered'
      ? sql`jsonb_set(${jobs.setupState}, '{notified_fingerprint}', to_jsonb(${input.setupFingerprint}::text), true)`
      : sql`jsonb_set(${jobs.setupState}, '{notified_fingerprint}', 'null'::jsonb, true)`;
  const rows = await tx
    .update(jobs)
    .set({ setupState, updatedAt: input.now })
    .where(
      and(
        eq(jobs.id, input.jobId),
        sql`${jobs.setupState} ->> 'fingerprint' = ${input.setupFingerprint}`,
      ),
    )
    .returning({ id: jobs.id });
  if (rows.length > 0) return;
  const [current] = await tx
    .select({ setupState: jobs.setupState })
    .from(jobs)
    .where(eq(jobs.id, input.jobId))
    .limit(1);
  const fingerprint = (current?.setupState as { fingerprint?: unknown })
    ?.fingerprint;
  if (current && fingerprint === input.setupFingerprint) {
    throw new Error('Setup delivery projection CAS failed unexpectedly.');
  }
}

function deliveryOutcomeForItemStatus(
  status: string,
): Exclude<JobSetupCardDeliveryOutcome, 'expired'> {
  if (status === 'sent') return 'delivered';
  if (status === 'partially_delivered') return 'ambiguous';
  if (status === 'failed') return 'exhausted';
  return 'cancelled';
}

function terminalDeliveryEventKey(
  promptId: string,
  generation: number,
): string {
  return `card_delivery_terminal:${promptId}:${generation}`;
}

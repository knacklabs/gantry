import { and, eq, inArray, sql } from 'drizzle-orm';

import type { OutboundDelivery } from '../../../../domain/outbound-delivery/outbound-delivery.js';
import type {
  PreparedSetupPermissionPrompt,
  SetupPermissionPromptPreparation,
  SetupPermissionPromptRepository,
} from '../../../../domain/ports/setup-permission-prompts.js';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../../../../domain/jobs/jobs.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import {
  encodeJson,
  mapDelivery,
} from './outbound-delivery-repository.postgres.helpers.js';

const ACTIVE_PROMPT_STATES = ['open', 'claimed'] as const;
const ACTIVE_ITEM_STATES = ['pending', 'claimed'] as const;

export function setupPermissionPromptDeliveryKey(
  promptId: string,
  generation: number,
): string {
  return `setup_permission_prompt:${promptId}:${generation}`;
}

export class PostgresSetupPermissionPromptRepository implements SetupPermissionPromptRepository {
  constructor(private readonly db: CanonicalDb) {}

  async prepareSetupPermissionPrompt(
    input: SetupPermissionPromptPreparation,
  ): Promise<PreparedSetupPermissionPrompt> {
    this.validateInput(input);
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({
          id: pgSchema.canonicalJobsPostgres.id,
          appId: pgSchema.canonicalJobsPostgres.appId,
          status: pgSchema.canonicalJobsPostgres.status,
          pauseReason: pgSchema.canonicalJobsPostgres.pauseReason,
          setupState: pgSchema.canonicalJobsPostgres.setupState,
        })
        .from(pgSchema.canonicalJobsPostgres)
        .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
        .for('update')
        .limit(1);
      const setupState = job?.setupState as
        | { state?: unknown; fingerprint?: unknown }
        | null
        | undefined;
      if (
        !job ||
        job.appId !== input.appId ||
        job.status !== 'paused' ||
        job.pauseReason !== SETUP_REQUIRED_PAUSE_REASON ||
        setupState?.state === 'ready' ||
        setupState?.fingerprint !== input.setupFingerprint
      ) {
        throw new Error('Setup permission prompt target is no longer current.');
      }

      await this.assertDeliveryRouteOwnedByApp(tx, input);

      const exactPrompt = await tx
        .select()
        .from(pgSchema.permissionPromptsPostgres)
        .where(eq(pgSchema.permissionPromptsPostgres.id, input.prompt.id))
        .for('update')
        .limit(1);
      const activePrompt = exactPrompt[0]
        ? exactPrompt[0]
        : (
            await tx
              .select()
              .from(pgSchema.permissionPromptsPostgres)
              .where(
                and(
                  eq(pgSchema.permissionPromptsPostgres.appId, input.appId),
                  eq(pgSchema.permissionPromptsPostgres.jobId, input.jobId),
                  eq(
                    pgSchema.permissionPromptsPostgres.setupFingerprint,
                    input.setupFingerprint,
                  ),
                  inArray(pgSchema.permissionPromptsPostgres.settlementState, [
                    ...ACTIVE_PROMPT_STATES,
                  ]),
                ),
              )
              .for('update')
              .limit(1)
          )[0];

      if (activePrompt) {
        this.assertPromptIdentity(activePrompt, input);
        // Generation authority lives HERE, under the prompt lock: an ACTIVE
        // generation replays its aggregate; otherwise the next generation is
        // max(existing)+1 - callers never propose generations.
        const active = await this.findActiveGenerationDelivery(tx, {
          appId: input.appId,
          promptId: activePrompt.id,
        });
        if (active) {
          return {
            created: false,
            promptId: activePrompt.id,
            interactionId: activePrompt.interactionId,
            generation: active.generation,
            delivery: active.delivery,
          };
        }
        if (
          !ACTIVE_PROMPT_STATES.some(
            (state) => state === activePrompt.settlementState,
          )
        ) {
          throw new Error(
            'A terminal setup permission prompt cannot be reopened.',
          );
        }
        const nextGeneration =
          (await this.maxGeneration(tx, activePrompt.id)) + 1;
        return this.insertDeliveryAggregate(
          tx,
          input,
          activePrompt.id,
          nextGeneration,
        );
      }

      await tx.insert(pgSchema.permissionPromptsPostgres).values({
        id: input.prompt.id,
        appId: input.appId,
        jobId: input.jobId,
        setupFingerprint: input.setupFingerprint,
        sourceAgentFolder: input.interaction.sourceAgentFolder,
        interactionId: input.prompt.interactionId,
        matchKind: 'individual',
        memberCount: 1,
        renderedDecisionOptionsJson:
          input.prompt.envelope.renderedDecisionOptions,
        renderedRequestJson: input.prompt.envelope.renderedRequest,
        targetJid: input.prompt.envelope.targetJid,
        approvalContextJid: input.prompt.envelope.approvalContextJid,
        threadId: input.prompt.envelope.threadId,
        decisionPolicy: input.prompt.envelope.decisionPolicy,
        fullViewJson: input.prompt.fullView ?? null,
        providerAliases: [...new Set(input.prompt.providerAliases)],
        settlementState: 'open',
        createdAt: input.delivery.createdAt,
        updatedAt: input.delivery.updatedAt,
      });
      await tx.insert(pgSchema.pendingInteractionsPostgres).values({
        id: input.interaction.id,
        appId: input.appId,
        runId: input.interaction.runId ?? null,
        envelopeId: input.prompt.id,
        memberIndex: 0,
        sourceAgentFolder: input.interaction.sourceAgentFolder,
        requestId: input.interaction.requestId,
        kind: 'permission',
        status: 'pending',
        payloadJson: input.interaction.payload,
        callbackRouteJson: input.interaction.callbackRoute ?? null,
        idempotencyKey: input.interaction.idempotencyKey,
        createdAt: input.delivery.createdAt,
        expiresAt: input.interaction.expiresAt,
      });
      return this.insertDeliveryAggregate(tx, input, input.prompt.id, 1);
    });
  }

  private validateInput(input: SetupPermissionPromptPreparation): void {
    const request = input.prompt.envelope.renderedRequest;
    if (
      input.prompt.providerAliases.length === 0 ||
      input.prompt.interactionId !== input.interaction.requestId ||
      request.appId !== input.appId ||
      request.jobId !== input.jobId ||
      request.setupFingerprint !== input.setupFingerprint ||
      input.finalAnswer.deliveryId !== input.delivery.id ||
      input.item.deliveryId !== input.delivery.id ||
      input.item.permissionPromptId !== input.prompt.id ||
      input.delivery.status !== 'pending' ||
      input.item.status !== 'pending' ||
      input.delivery.profileId.length === 0
    ) {
      throw new Error('Invalid setup permission prompt preparation input.');
    }
  }

  private assertPromptIdentity(
    prompt: typeof pgSchema.permissionPromptsPostgres.$inferSelect,
    input: SetupPermissionPromptPreparation,
  ): void {
    if (
      prompt.appId !== input.appId ||
      prompt.jobId !== input.jobId ||
      prompt.setupFingerprint !== input.setupFingerprint
    ) {
      throw new Error('Setup permission prompt identity conflict.');
    }
  }

  private async assertDeliveryRouteOwnedByApp(
    tx: CanonicalExecutor,
    input: SetupPermissionPromptPreparation,
  ): Promise<void> {
    const [conversation] = await tx
      .select({ id: pgSchema.conversationsPostgres.id })
      .from(pgSchema.conversationsPostgres)
      .where(
        and(
          eq(pgSchema.conversationsPostgres.id, input.delivery.conversationId),
          eq(pgSchema.conversationsPostgres.appId, input.appId),
        ),
      )
      .limit(1);
    if (!conversation) {
      throw new Error(
        'Setup permission delivery route belongs to another app.',
      );
    }
    if (input.delivery.agentId) {
      const [agent] = await tx
        .select({ id: pgSchema.agentsPostgres.id })
        .from(pgSchema.agentsPostgres)
        .where(
          and(
            eq(pgSchema.agentsPostgres.id, input.delivery.agentId),
            eq(pgSchema.agentsPostgres.appId, input.appId),
          ),
        )
        .limit(1);
      if (!agent) {
        throw new Error(
          'Setup permission delivery agent belongs to another app.',
        );
      }
    }
    for (const runId of new Set(
      [input.delivery.runId, input.interaction.runId].filter(
        (value): value is NonNullable<typeof value> => Boolean(value),
      ),
    )) {
      const [run] = await tx
        .select({ id: pgSchema.agentRunsPostgres.id })
        .from(pgSchema.agentRunsPostgres)
        .where(
          and(
            eq(pgSchema.agentRunsPostgres.id, runId),
            eq(pgSchema.agentRunsPostgres.appId, input.appId),
          ),
        )
        .limit(1);
      if (!run) {
        throw new Error(
          'Setup permission delivery run belongs to another app.',
        );
      }
    }
    if (!input.delivery.threadId) return;
    const [thread] = await tx
      .select({ id: pgSchema.conversationThreadsPostgres.id })
      .from(pgSchema.conversationThreadsPostgres)
      .where(
        and(
          eq(pgSchema.conversationThreadsPostgres.id, input.delivery.threadId),
          eq(pgSchema.conversationThreadsPostgres.appId, input.appId),
          eq(
            pgSchema.conversationThreadsPostgres.conversationId,
            input.delivery.conversationId,
          ),
        ),
      )
      .limit(1);
    if (!thread) {
      throw new Error(
        'Setup permission delivery thread belongs to another app.',
      );
    }
  }

  private async findActiveGenerationDelivery(
    tx: CanonicalExecutor,
    input: { appId: string; promptId: string },
  ): Promise<{ generation: number; delivery: OutboundDelivery } | null> {
    const [row] = await tx
      .select({
        delivery: pgSchema.outboundDeliveriesPostgres,
        generation: pgSchema.outboundDeliveryItemsPostgres.generation,
      })
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
          eq(
            pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
            input.promptId,
          ),
          inArray(pgSchema.outboundDeliveryItemsPostgres.status, [
            ...ACTIVE_ITEM_STATES,
          ]),
          eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId),
        ),
      )
      .limit(1);
    return row
      ? { generation: row.generation, delivery: mapDelivery(row.delivery) }
      : null;
  }

  private async maxGeneration(
    tx: CanonicalExecutor,
    promptId: string,
  ): Promise<number> {
    const [row] = await tx
      .select({
        max: sql<number>`coalesce(max(${pgSchema.outboundDeliveryItemsPostgres.generation}), 0)`,
      })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        eq(pgSchema.outboundDeliveryItemsPostgres.permissionPromptId, promptId),
      );
    return Number(row?.max ?? 0);
  }

  private async insertDeliveryAggregate(
    tx: CanonicalExecutor,
    input: SetupPermissionPromptPreparation,
    promptId: string,
    generation: number,
  ): Promise<PreparedSetupPermissionPrompt> {
    const idempotencyKey = setupPermissionPromptDeliveryKey(
      promptId,
      generation,
    );
    const [deliveryRow] = await tx
      .insert(pgSchema.outboundDeliveriesPostgres)
      .values({
        id: input.delivery.id,
        appId: input.appId,
        conversationId: input.delivery.conversationId,
        threadId: input.delivery.threadId ?? null,
        agentId: input.delivery.agentId ?? null,
        runId: input.delivery.runId ?? null,
        profileId: input.delivery.profileId,
        idempotencyKey,
        idempotencyFingerprint: input.delivery.idempotencyFingerprint,
        status: input.delivery.status,
        settledAt: input.delivery.settledAt ?? null,
        lastError: input.delivery.lastError ?? null,
        cancellationReasonJson: input.delivery.cancellationReason ?? null,
        createdAt: input.delivery.createdAt,
        updatedAt: input.delivery.updatedAt,
      })
      .returning();
    await tx.insert(pgSchema.outboundDeliveryFinalAnswersPostgres).values({
      deliveryId: input.finalAnswer.deliveryId,
      canonicalText: input.finalAnswer.canonicalText,
      segmentCount: input.finalAnswer.segmentCount,
      createdAt: input.finalAnswer.createdAt,
      updatedAt: input.finalAnswer.updatedAt,
    });
    await tx.insert(pgSchema.outboundDeliveryItemsPostgres).values({
      id: input.item.id,
      deliveryId: input.item.deliveryId,
      permissionPromptId: promptId,
      generation,
      ordinal: input.item.ordinal,
      canonicalText: input.item.canonicalText,
      providerPayloadJson:
        input.item.providerPayload === undefined
          ? null
          : encodeJson(
              sanitizeRetryTailProviderPayload(input.item.providerPayload),
            ),
      status: input.item.status,
      attemptCount: input.item.attemptCount,
      claimToken: input.item.claimToken ?? null,
      claimOwner: null,
      claimExpiresAt: input.item.claimExpiresAt ?? null,
      sendBegunAt: input.item.sendBegunAt ?? null,
      nextAttemptAt: input.item.nextAttemptAt,
      sentAt: input.item.sentAt ?? null,
      failedAt: input.item.failedAt ?? null,
      lastError: input.item.lastError ?? null,
      cancellationReasonJson: input.item.cancellationReason ?? null,
      createdAt: input.item.createdAt,
      updatedAt: input.item.updatedAt,
    });
    return {
      created: true,
      promptId,
      interactionId: input.prompt.interactionId,
      generation,
      delivery: mapDelivery(deliveryRow!),
    };
  }
}

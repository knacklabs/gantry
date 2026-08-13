import { and, eq, inArray } from 'drizzle-orm';

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
        const replay = await this.findGenerationDelivery(tx, {
          appId: input.appId,
          promptId: activePrompt.id,
          generation: input.generation,
        });
        if (replay) {
          this.assertDeliveryReplay(replay, input, activePrompt.id);
          return {
            created: false,
            promptId: activePrompt.id,
            interactionId: activePrompt.interactionId,
            generation: input.generation,
            delivery: replay,
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
        return this.insertDeliveryAggregate(tx, input, activePrompt.id);
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
      return this.insertDeliveryAggregate(tx, input, input.prompt.id);
    });
  }

  private validateInput(input: SetupPermissionPromptPreparation): void {
    const request = input.prompt.envelope.renderedRequest;
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.prompt.providerAliases.length === 0 ||
      input.prompt.interactionId !== input.interaction.requestId ||
      request.appId !== input.appId ||
      request.jobId !== input.jobId ||
      request.setupFingerprint !== input.setupFingerprint ||
      input.finalAnswer.deliveryId !== input.delivery.id ||
      input.item.deliveryId !== input.delivery.id ||
      input.item.permissionPromptId !== input.prompt.id ||
      input.item.generation !== input.generation ||
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

  private async findGenerationDelivery(
    tx: CanonicalExecutor,
    input: { appId: string; promptId: string; generation: number },
  ): Promise<OutboundDelivery | null> {
    const [row] = await tx
      .select({ delivery: pgSchema.outboundDeliveriesPostgres })
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
          eq(
            pgSchema.outboundDeliveryItemsPostgres.generation,
            input.generation,
          ),
          eq(pgSchema.outboundDeliveriesPostgres.appId, input.appId),
        ),
      )
      .limit(1);
    return row ? mapDelivery(row.delivery) : null;
  }

  private assertDeliveryReplay(
    delivery: OutboundDelivery,
    input: SetupPermissionPromptPreparation,
    promptId: string,
  ): void {
    if (
      delivery.idempotencyKey !==
        setupPermissionPromptDeliveryKey(promptId, input.generation) ||
      delivery.idempotencyFingerprint !==
        input.delivery.idempotencyFingerprint ||
      delivery.profileId !== input.delivery.profileId ||
      delivery.conversationId !== input.delivery.conversationId ||
      delivery.threadId !== input.delivery.threadId
    ) {
      throw new Error('Setup permission delivery idempotency conflict.');
    }
  }

  private async insertDeliveryAggregate(
    tx: CanonicalExecutor,
    input: SetupPermissionPromptPreparation,
    promptId: string,
  ): Promise<PreparedSetupPermissionPrompt> {
    const idempotencyKey = setupPermissionPromptDeliveryKey(
      promptId,
      input.generation,
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
      generation: input.generation,
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
      generation: input.generation,
      delivery: mapDelivery(deliveryRow!),
    };
  }
}

import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupPermissionPromptDeliveryKey } from '@core/adapters/storage/postgres/repositories/setup-permission-prompt-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import type { SetupPermissionPromptPreparation } from '@core/domain/ports/setup-permission-prompts.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const now = '2026-08-13T10:00:00.000Z';
const later = '2026-08-13T10:01:00.000Z';

maybeDescribe('setup permission prompt preparation', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'setup_prompt_prepare',
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: 'provider-account:setup-prompt' as never,
      appId: 'default' as never,
      agentId: 'agent:main_agent' as never,
      providerId: 'telegram' as never,
      externalIdentityRef: { kind: 'provider_account', value: 'setup-prompt' },
      label: 'Setup prompt test account',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: 'conversation:setup-prompt' as never,
      appId: 'default' as never,
      providerAccountId: 'provider-account:setup-prompt' as never,
      externalRef: { kind: 'conversation', value: 'setup-prompt' },
      kind: 'dm',
      title: 'Setup prompt test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.apps.saveApp({
      id: 'app:setup-prompt-other' as never,
      slug: 'setup-prompt-other',
      name: 'Setup prompt other app',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.agents.saveAgent({
      id: 'agent:setup-prompt-other' as never,
      appId: 'app:setup-prompt-other' as never,
      name: 'Setup prompt other agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: 'provider-account:setup-prompt-other' as never,
      appId: 'app:setup-prompt-other' as never,
      agentId: 'agent:setup-prompt-other' as never,
      providerId: 'telegram' as never,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'setup-prompt-other',
      },
      label: 'Setup prompt other account',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: 'conversation:setup-prompt-other' as never,
      appId: 'app:setup-prompt-other' as never,
      providerAccountId: 'provider-account:setup-prompt-other' as never,
      externalRef: { kind: 'conversation', value: 'setup-prompt-other' },
      kind: 'dm',
      title: 'Setup prompt other app',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('atomically prepares one generation, replays it, and retains terminal audit history after job deletion', async () => {
    await insertSetupPausedJob(runtime, 'job:setup-prompt:retention', 'fp:a');
    const first = preparation({
      jobId: 'job:setup-prompt:retention',
      promptId: 'prompt:setup:a',
      interactionId: 'interaction:setup:a',
      generation: 1,
      fingerprint: 'fp:a',
    });

    const created =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        first,
      );
    const replay =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        first,
      );

    expect(created).toMatchObject({
      created: true,
      promptId: 'prompt:setup:a',
      interactionId: 'request:setup:a',
      generation: 1,
    });
    expect(created.delivery.idempotencyKey).toBe(
      setupPermissionPromptDeliveryKey('prompt:setup:a', 1),
    );
    expect(replay).toMatchObject({
      created: false,
      promptId: 'prompt:setup:a',
      generation: 1,
      delivery: { id: created.delivery.id },
    });

    const secondGeneration = preparation({
      jobId: 'job:setup-prompt:retention',
      promptId: 'prompt:setup:a',
      interactionId: 'interaction:setup:a',
      generation: 2,
      fingerprint: 'fp:a',
    });
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        secondGeneration,
      ),
    ).rejects.toBeTruthy();
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({ status: 'failed', failedAt: later, updatedAt: later })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:a',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({ status: 'failed', settledAt: later, updatedAt: later })
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, first.delivery.id));
    const regenerated =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        secondGeneration,
      );
    const regeneratedReplay =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        secondGeneration,
      );
    expect(regenerated).toMatchObject({ created: true, generation: 2 });
    expect(regenerated.delivery.idempotencyKey).toBe(
      setupPermissionPromptDeliveryKey('prompt:setup:a', 2),
    );
    expect(regeneratedReplay).toMatchObject({
      created: false,
      generation: 2,
      delivery: { id: regenerated.delivery.id },
    });

    await expect(
      runtime.service.db.insert(pgSchema.permissionPromptsPostgres).values({
        id: 'prompt:setup:duplicate-active',
        appId: 'default',
        jobId: 'job:setup-prompt:retention',
        setupFingerprint: 'fp:a',
        sourceAgentFolder: 'main_agent',
        interactionId: 'request:setup:duplicate-active',
        matchKind: 'individual',
        memberCount: 1,
        renderedDecisionOptionsJson: ['allow_persistent_rule'],
        renderedRequestJson: {},
        providerAliases: ['prompt:setup:duplicate-active'],
        settlementState: 'open',
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeTruthy();

    await runtime.service.db
      .update(pgSchema.permissionPromptsPostgres)
      .set({ settlementState: 'expired', settledAt: later, updatedAt: later })
      .where(eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:a'));
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'cancelled',
        cancellationReasonJson: { code: 'prompt_expired' },
        updatedAt: later,
      })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:a',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({
        status: 'cancelled',
        cancellationReasonJson: { code: 'prompt_expired' },
        settledAt: later,
        updatedAt: later,
      })
      .where(
        inArray(pgSchema.outboundDeliveriesPostgres.id, [
          first.delivery.id,
          regenerated.delivery.id,
        ]),
      );

    const reissued = preparation({
      jobId: 'job:setup-prompt:retention',
      promptId: 'prompt:setup:b',
      interactionId: 'interaction:setup:b',
      generation: 1,
      fingerprint: 'fp:a',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      reissued,
    );
    await runtime.service.db
      .update(pgSchema.permissionPromptsPostgres)
      .set({ settlementState: 'cancelled', settledAt: later, updatedAt: later })
      .where(eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:b'));
    await runtime.service.db
      .delete(pgSchema.canonicalJobsPostgres)
      .where(
        eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:retention'),
      );

    const retained = await runtime.service.db
      .select({
        id: pgSchema.permissionPromptsPostgres.id,
        jobId: pgSchema.permissionPromptsPostgres.jobId,
      })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        eq(
          pgSchema.permissionPromptsPostgres.jobId,
          'job:setup-prompt:retention',
        ),
      )
      .orderBy(asc(pgSchema.permissionPromptsPostgres.id));
    expect(retained).toEqual([
      { id: 'prompt:setup:a', jobId: 'job:setup-prompt:retention' },
      { id: 'prompt:setup:b', jobId: 'job:setup-prompt:retention' },
    ]);
  });

  it('rolls back every prepared row when locked job revalidation or aggregate insertion fails', async () => {
    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:rollback',
      'fp:current',
    );
    const stale = preparation({
      jobId: 'job:setup-prompt:rollback',
      promptId: 'prompt:setup:stale',
      interactionId: 'interaction:setup:stale',
      generation: 1,
      fingerprint: 'fp:stale',
    });
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        stale,
      ),
    ).rejects.toThrow('no longer current');

    const crossApp = preparation({
      jobId: 'job:setup-prompt:rollback',
      promptId: 'prompt:setup:cross-app',
      interactionId: 'interaction:setup:cross-app',
      generation: 1,
      fingerprint: 'fp:current',
    });
    crossApp.delivery.conversationId =
      'conversation:setup-prompt-other' as never;
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        crossApp,
      ),
    ).rejects.toThrow('another app');

    const invalidAggregate = preparation({
      jobId: 'job:setup-prompt:rollback',
      promptId: 'prompt:setup:rollback',
      interactionId: 'interaction:setup:rollback',
      generation: 1,
      fingerprint: 'fp:current',
    });
    await runtime.service.db
      .insert(pgSchema.outboundDeliveriesPostgres)
      .values({
        id: invalidAggregate.delivery.id,
        appId: 'default',
        conversationId: invalidAggregate.delivery.conversationId,
        profileId: 'preexisting-test-row',
        idempotencyKey: 'preexisting-test-row',
        idempotencyFingerprint: 'preexisting-test-row',
        status: 'failed',
        settledAt: now,
        createdAt: now,
        updatedAt: now,
      });
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        invalidAggregate,
      ),
    ).rejects.toBeTruthy();

    const prompts = await runtime.service.db
      .select({ id: pgSchema.permissionPromptsPostgres.id })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        eq(
          pgSchema.permissionPromptsPostgres.jobId,
          'job:setup-prompt:rollback',
        ),
      );
    const interactions = await runtime.service.db
      .select({ id: pgSchema.pendingInteractionsPostgres.id })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(
          pgSchema.pendingInteractionsPostgres.requestId,
          invalidAggregate.interaction.requestId,
        ),
      );
    expect(prompts).toEqual([]);
    expect(interactions).toEqual([]);
  });
});

async function insertSetupPausedJob(
  runtime: PostgresIntegrationRuntime,
  id: string,
  fingerprint: string,
): Promise<void> {
  await runtime.service.db.insert(pgSchema.canonicalJobsPostgres).values({
    id,
    appId: 'default',
    createdByActorId: 'test:setup-prompt',
    createdBySource: 'test',
    name: id,
    prompt: 'Test setup prompt preparation',
    scheduleJson: { type: 'manual' },
    targetJson: {},
    status: 'paused',
    pauseReason: 'Setup required',
    setupState: { state: 'blocked', fingerprint },
    createdAt: now,
    updatedAt: now,
  });
}

function preparation(input: {
  jobId: string;
  promptId: string;
  interactionId: string;
  generation: number;
  fingerprint: string;
}): SetupPermissionPromptPreparation {
  const requestId = input.interactionId.replace('interaction:', 'request:');
  const deliveryId = `delivery:${input.promptId}:${input.generation}` as never;
  return {
    appId: 'default',
    jobId: input.jobId,
    setupFingerprint: input.fingerprint,
    generation: input.generation,
    interaction: {
      id: input.interactionId,
      sourceAgentFolder: 'main_agent',
      requestId,
      payload: { requestId },
      idempotencyKey: `default:permission:main_agent:${requestId}`,
      expiresAt: '2026-08-14T10:00:00.000Z',
    },
    prompt: {
      id: input.promptId,
      interactionId: requestId,
      envelope: {
        version: 1,
        renderedDecisionOptions: ['allow_persistent_rule'],
        targetJid: 'tg:setup-prompt',
        approvalContextJid: 'tg:setup-prompt',
        threadId: null,
        decisionPolicy: 'same_channel',
        renderedRequest: {
          requestId,
          appId: 'default',
          sourceAgentFolder: 'main_agent',
          jobId: input.jobId,
          setupFingerprint: input.fingerprint,
          targetJid: 'tg:setup-prompt',
          toolName: 'request_permission',
        },
      },
      providerAliases: [input.promptId],
    },
    delivery: {
      id: deliveryId,
      conversationId: 'conversation:setup-prompt' as never,
      profileId: 'setup_permission_prompt',
      idempotencyFingerprint: `delivery-fingerprint:${input.promptId}:${input.generation}`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    },
    finalAnswer: {
      deliveryId,
      canonicalText: 'Approve setup',
      segmentCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    item: {
      id: `item:${input.promptId}:${input.generation}` as never,
      deliveryId,
      permissionPromptId: input.promptId,
      generation: input.generation,
      ordinal: 0,
      canonicalText: 'Approve setup',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    },
  };
}

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
    });
    expect(created.delivery.idempotencyKey).toBe(
      setupPermissionPromptDeliveryKey('prompt:setup:a', 1),
    );
    expect(replay).toMatchObject({
      created: false,
      promptId: 'prompt:setup:a',
      delivery: { id: created.delivery.id },
    });

    const secondGeneration = preparation({
      jobId: 'job:setup-prompt:retention',
      promptId: 'prompt:setup:a',
      interactionId: 'interaction:setup:a',
      fingerprint: 'fp:a',
    });
    // Internal generation authority: while generation 1 is ACTIVE, another
    // preparation replays it instead of allocating a second generation.
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        secondGeneration,
      ),
    ).resolves.toMatchObject({ created: false, generation: 1 });
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

  it('fences send begin, distinguishes pre-send expiry, and settles the prompt locator atomically', async () => {
    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:dispatch',
      'fp:dispatch',
    );
    const preparedInput = preparation({
      jobId: 'job:setup-prompt:dispatch',
      promptId: 'prompt:setup:dispatch',
      interactionId: 'interaction:setup:dispatch',
      fingerprint: 'fp:dispatch',
    });
    const prepared =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        preparedInput,
      );
    // Earlier tests may leave their own due items; claim broadly and pick
    // THIS prompt's item.
    const claimed =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now,
        claimerId: 'test:dispatch',
        leaseMs: 30_000,
        limit: 10,
      });
    const claim = claimed.find(
      (entry) => entry.item.permissionPromptId === 'prompt:setup:dispatch',
    );
    expect(claim).toBeTruthy();
    const item = claim!.item;
    const view =
      await runtime.repositories.outboundDeliveries.getSetupPermissionPromptForDispatch?.(
        {
          appId: 'default' as never,
          promptId: 'prompt:setup:dispatch',
          now,
        },
      );
    expect(view).toMatchObject({
      providerAlias: 'prompt:setup:dispatch',
      request: { setupFingerprint: 'fp:dispatch' },
    });
    await expect(
      runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
        deliveryId: prepared.delivery.id,
        itemId: item.id,
        promptId: 'prompt:setup:dispatch',
        claimToken: 'stale-claim-token',
        begunAt: '2026-08-13T10:00:01.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
        deliveryId: prepared.delivery.id,
        itemId: item.id,
        promptId: 'prompt:setup:dispatch',
        claimToken: item.claimToken!,
        begunAt: '2026-08-13T10:00:01.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.repositories.outboundDeliveries.markDeliveryItemSent({
        deliveryId: prepared.delivery.id,
        itemId: item.id,
        claimToken: item.claimToken!,
        receipt: {
          id: 'receipt:setup:dispatch' as never,
          deliveryId: prepared.delivery.id,
          itemId: item.id,
          idempotencyKey: 'item:dispatch:receipt',
          providerMessageId: 'message:dispatch',
          sentAt: '2026-08-13T10:00:01.000Z',
          createdAt: '2026-08-13T10:00:01.000Z',
        },
        permissionPromptLocator: {
          provider: 'telegram',
          conversationId: 'setup-prompt',
          messageId: 'message:dispatch',
        },
      }),
    ).resolves.toMatchObject({ applied: true });

    const [storedPrompt] = await runtime.service.db
      .select({
        provider: pgSchema.permissionPromptsPostgres.externalPromptProvider,
        messageId: pgSchema.permissionPromptsPostgres.externalPromptMessageId,
      })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:dispatch'),
      );
    const [storedItem] = await runtime.service.db
      .select({ status: pgSchema.outboundDeliveryItemsPostgres.status })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(eq(pgSchema.outboundDeliveryItemsPostgres.id, item.id));
    const receipts = await runtime.service.db
      .select({ id: pgSchema.outboundDeliveryReceiptsPostgres.id })
      .from(pgSchema.outboundDeliveryReceiptsPostgres)
      .where(eq(pgSchema.outboundDeliveryReceiptsPostgres.itemId, item.id));
    expect(storedPrompt).toEqual({
      provider: 'telegram',
      messageId: 'message:dispatch',
    });
    expect(storedItem).toEqual({ status: 'sent' });
    expect(receipts).toEqual([{ id: 'receipt:setup:dispatch' }]);

    await insertSetupPausedJob(runtime, 'job:setup-prompt:expiry', 'fp:expiry');
    const expiryInput = preparation({
      jobId: 'job:setup-prompt:expiry',
      promptId: 'prompt:setup:expiry',
      interactionId: 'interaction:setup:expiry',
      fingerprint: 'fp:expiry',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      expiryInput,
    );
    await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'setup_permission_prompt',
      now,
      claimerId: 'test:expiry',
      leaseMs: 1_000,
      limit: 10,
    });
    await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'setup_permission_prompt',
      now: '2026-08-13T10:00:02.000Z',
      claimerId: 'test:expiry-recovery',
      leaseMs: 1_000,
      limit: 10,
    });
    const [expiredBeforeSend] = await runtime.service.db
      .select({ status: pgSchema.outboundDeliveryItemsPostgres.status })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:expiry',
        ),
      );
    expect(expiredBeforeSend).toEqual({ status: 'pending' });

    const reclaimedAll =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now: '2026-08-13T10:00:04.000Z',
        claimerId: 'test:expiry-after-begin',
        leaseMs: 1_000,
        limit: 10,
      });
    const reclaimed = reclaimedAll.filter(
      (entry) => entry.item.permissionPromptId === 'prompt:setup:expiry',
    );
    expect(reclaimed).toHaveLength(1);
    await runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
      deliveryId: reclaimed[0]!.delivery.id,
      itemId: reclaimed[0]!.item.id,
      promptId: 'prompt:setup:expiry',
      claimToken: reclaimed[0]!.item.claimToken!,
      begunAt: '2026-08-13T10:00:04.500Z',
    });
    await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'setup_permission_prompt',
      now: '2026-08-13T10:00:06.000Z',
      claimerId: 'test:ambiguous-recovery',
      leaseMs: 1_000,
      limit: 1,
    });
    const [expiredAfterSendBegin] = await runtime.service.db
      .select({ status: pgSchema.outboundDeliveryItemsPostgres.status })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:expiry',
        ),
      );
    expect(expiredAfterSendBegin).toEqual({
      status: 'partially_delivered',
    });
  });

  it('revalidates cancellation before send and rolls back a conflicting locator settlement', async () => {
    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:cancelled-before-send',
      'fp:cancelled-before-send',
    );
    const cancelledPrepared =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        preparation({
          jobId: 'job:setup-prompt:cancelled-before-send',
          promptId: 'prompt:setup:cancelled-before-send',
          interactionId: 'interaction:setup:cancelled-before-send',
          fingerprint: 'fp:cancelled-before-send',
        }),
      );
    const [cancelledClaim] =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now,
        claimerId: 'test:cancelled-before-send',
        leaseMs: 30_000,
        limit: 1,
      });
    await runtime.service.db
      .update(pgSchema.permissionPromptsPostgres)
      .set({ settlementState: 'cancelled', updatedAt: now })
      .where(
        eq(
          pgSchema.permissionPromptsPostgres.id,
          'prompt:setup:cancelled-before-send',
        ),
      );
    await expect(
      runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
        deliveryId: cancelledPrepared.delivery.id,
        itemId: cancelledClaim!.item.id,
        promptId: 'prompt:setup:cancelled-before-send',
        claimToken: cancelledClaim!.item.claimToken!,
        begunAt: '2026-08-13T10:00:01.000Z',
      }),
    ).resolves.toBe(false);

    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:atomic-settlement',
      'fp:atomic-settlement',
    );
    const atomicPrepared =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        preparation({
          jobId: 'job:setup-prompt:atomic-settlement',
          promptId: 'prompt:setup:atomic-settlement',
          interactionId: 'interaction:setup:atomic-settlement',
          fingerprint: 'fp:atomic-settlement',
        }),
      );
    const [atomicClaim] =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now,
        claimerId: 'test:atomic-settlement',
        leaseMs: 30_000,
        limit: 1,
      });
    await runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
      deliveryId: atomicPrepared.delivery.id,
      itemId: atomicClaim!.item.id,
      promptId: 'prompt:setup:atomic-settlement',
      claimToken: atomicClaim!.item.claimToken!,
      begunAt: '2026-08-13T10:00:01.000Z',
    });
    await runtime.service.db
      .update(pgSchema.permissionPromptsPostgres)
      .set({
        externalPromptProvider: 'telegram',
        externalPromptConversationId: 'expected-conversation',
        externalPromptMessageId: 'expected-message',
        updatedAt: now,
      })
      .where(
        eq(
          pgSchema.permissionPromptsPostgres.id,
          'prompt:setup:atomic-settlement',
        ),
      );

    await expect(
      runtime.repositories.outboundDeliveries.markDeliveryItemSent({
        deliveryId: atomicPrepared.delivery.id,
        itemId: atomicClaim!.item.id,
        claimToken: atomicClaim!.item.claimToken!,
        receipt: {
          id: 'receipt:setup:atomic-conflict' as never,
          deliveryId: atomicPrepared.delivery.id,
          itemId: atomicClaim!.item.id,
          idempotencyKey: 'item:atomic-conflict:receipt',
          providerMessageId: 'conflicting-message',
          sentAt: '2026-08-13T10:00:02.000Z',
          createdAt: '2026-08-13T10:00:02.000Z',
        },
        permissionPromptLocator: {
          provider: 'telegram',
          conversationId: 'conflicting-conversation',
          messageId: 'conflicting-message',
        },
      }),
    ).rejects.toThrow('locator settlement conflicted');

    const [atomicItem] = await runtime.service.db
      .select({ status: pgSchema.outboundDeliveryItemsPostgres.status })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        eq(pgSchema.outboundDeliveryItemsPostgres.id, atomicClaim!.item.id),
      );
    const conflictingReceipts = await runtime.service.db
      .select({ id: pgSchema.outboundDeliveryReceiptsPostgres.id })
      .from(pgSchema.outboundDeliveryReceiptsPostgres)
      .where(
        eq(
          pgSchema.outboundDeliveryReceiptsPostgres.itemId,
          atomicClaim!.item.id,
        ),
      );
    expect(atomicItem).toEqual({ status: 'claimed' });
    expect(conflictingReceipts).toEqual([]);
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

let preparationAttempt = 0;

function preparation(input: {
  jobId: string;
  promptId: string;
  interactionId: string;
  fingerprint: string;
}): SetupPermissionPromptPreparation {
  // Row ids are per-attempt (generation is repository-internal now).
  const attempt = ++preparationAttempt;
  const requestId = input.interactionId.replace('interaction:', 'request:');
  const deliveryId = `delivery:${input.promptId}:${attempt}` as never;
  return {
    appId: 'default',
    jobId: input.jobId,
    setupFingerprint: input.fingerprint,
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
      idempotencyFingerprint: `delivery-fingerprint:${input.promptId}`,
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
      id: `item:${input.promptId}:${attempt}` as never,
      deliveryId,
      permissionPromptId: input.promptId,
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

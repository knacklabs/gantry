import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupPermissionPromptDeliveryKey } from '@core/adapters/storage/postgres/repositories/setup-permission-prompt-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import type { SetupPermissionPromptPreparation } from '@core/domain/ports/setup-permission-prompts.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

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
    const reissuedPrepared =
      await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        reissued,
      );
    await runtime.ops.deleteJob('job:setup-prompt:retention');

    const retained = await runtime.service.db
      .select({
        id: pgSchema.permissionPromptsPostgres.id,
        jobId: pgSchema.permissionPromptsPostgres.jobId,
        state: pgSchema.permissionPromptsPostgres.settlementState,
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
      {
        id: 'prompt:setup:a',
        jobId: 'job:setup-prompt:retention',
        state: 'expired',
      },
      {
        id: 'prompt:setup:b',
        jobId: 'job:setup-prompt:retention',
        state: 'cancelled',
      },
    ]);
    const [interaction] = await runtime.service.db
      .select({
        status: pgSchema.pendingInteractionsPostgres.status,
        resolution: pgSchema.pendingInteractionsPostgres.resolutionJson,
      })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(pgSchema.pendingInteractionsPostgres.envelopeId, 'prompt:setup:b'),
      );
    const [item] = await runtime.service.db
      .select({
        status: pgSchema.outboundDeliveryItemsPostgres.status,
        reason: pgSchema.outboundDeliveryItemsPostgres.cancellationReasonJson,
      })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:b',
        ),
      );
    const [delivery] = await runtime.service.db
      .select({
        status: pgSchema.outboundDeliveriesPostgres.status,
        reason: pgSchema.outboundDeliveriesPostgres.cancellationReasonJson,
      })
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(
        eq(
          pgSchema.outboundDeliveriesPostgres.id,
          reissuedPrepared.delivery.id,
        ),
      );
    const reason = {
      code: 'job_deleted',
      job_id: 'job:setup-prompt:retention',
    };
    const [deletedJob] = await runtime.service.db
      .select({ id: pgSchema.canonicalJobsPostgres.id })
      .from(pgSchema.canonicalJobsPostgres)
      .where(
        eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:retention'),
      );
    expect(deletedJob).toBeUndefined();
    expect(interaction).toEqual({ status: 'cancelled', resolution: reason });
    expect(item).toEqual({ status: 'cancelled', reason });
    expect(delivery).toEqual({ status: 'cancelled', reason });
  });

  it('rolls back job and prompt cancellation when delivery cancellation cannot safely settle', async () => {
    const jobId = 'job:setup-prompt:delete-rollback';
    const promptId = 'prompt:setup:delete-rollback';
    await insertSetupPausedJob(runtime, jobId, 'fp:delete-rollback');
    const prepared = preparation({
      jobId,
      promptId,
      interactionId: 'interaction:setup:delete-rollback',
      fingerprint: 'fp:delete-rollback',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      prepared,
    );
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'claimed',
        claimToken: 'claim:delete-rollback',
        claimOwner: 'worker:delete-rollback',
        sendBegunAt: later,
        updatedAt: later,
      })
      .where(
        eq(pgSchema.outboundDeliveryItemsPostgres.permissionPromptId, promptId),
      );

    await expect(runtime.ops.deleteJob(jobId)).rejects.toThrow(
      'setup prompt delivery send has already begun',
    );

    const [job] = await runtime.service.db
      .select({ id: pgSchema.canonicalJobsPostgres.id })
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, jobId));
    const [prompt] = await runtime.service.db
      .select({ state: pgSchema.permissionPromptsPostgres.settlementState })
      .from(pgSchema.permissionPromptsPostgres)
      .where(eq(pgSchema.permissionPromptsPostgres.id, promptId));
    const [interaction] = await runtime.service.db
      .select({ status: pgSchema.pendingInteractionsPostgres.status })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(eq(pgSchema.pendingInteractionsPostgres.envelopeId, promptId));
    const [delivery] = await runtime.service.db
      .select({ status: pgSchema.outboundDeliveriesPostgres.status })
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, prepared.delivery.id));
    const [item] = await runtime.service.db
      .select({ status: pgSchema.outboundDeliveryItemsPostgres.status })
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(
        eq(pgSchema.outboundDeliveryItemsPostgres.permissionPromptId, promptId),
      );
    expect(job).toEqual({ id: jobId });
    expect(prompt).toEqual({ state: 'open' });
    expect(interaction).toEqual({ status: 'pending' });
    expect(delivery).toEqual({ status: 'pending' });
    expect(item).toEqual({ status: 'claimed' });

    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({ sendBegunAt: null, updatedAt: later })
      .where(
        eq(pgSchema.outboundDeliveryItemsPostgres.permissionPromptId, promptId),
      );
    await runtime.ops.deleteJob(jobId);
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
    // Lease validity is checked against DATABASE time - claim with a live
    // timestamp so the checkpoint sees an unexpired lease.
    const liveNow = new Date().toISOString();
    const claimed =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now: liveNow,
        claimerId: 'test:dispatch',
        leaseMs: 60_000,
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
    ).resolves.toBe('lease_lost');
    await expect(
      runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
        deliveryId: prepared.delivery.id,
        itemId: item.id,
        promptId: 'prompt:setup:dispatch',
        claimToken: item.claimToken!,
        begunAt: '2026-08-13T10:00:01.000Z',
      }),
    ).resolves.toBe('begun');
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

    // beginSend judges the lease by DATABASE time, so the reclaim must hold
    // a live unexpired lease; the later sweep passes a future `now` to see
    // that same lease as expired without sleeping.
    const reclaimedAll =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now: new Date().toISOString(),
        claimerId: 'test:expiry-after-begin',
        leaseMs: 5_000,
        limit: 10,
      });
    const reclaimed = reclaimedAll.filter(
      (entry) => entry.item.permissionPromptId === 'prompt:setup:expiry',
    );
    expect(reclaimed).toHaveLength(1);
    await expect(
      runtime.repositories.outboundDeliveries.beginDeliveryItemSend?.({
        deliveryId: reclaimed[0]!.delivery.id,
        itemId: reclaimed[0]!.item.id,
        promptId: 'prompt:setup:expiry',
        claimToken: reclaimed[0]!.item.claimToken!,
        begunAt: new Date().toISOString(),
      }),
    ).resolves.toBe('begun');
    await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'setup_permission_prompt',
      now: new Date(Date.now() + 60_000).toISOString(),
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
    const cancelledClaims =
      await runtime.repositories.outboundDeliveries.claimDueDeliveryItems({
        appId: 'default' as never,
        profileId: 'setup_permission_prompt',
        now: new Date().toISOString(),
        claimerId: 'test:cancelled-before-send',
        leaseMs: 60_000,
        limit: 10,
      });
    const cancelledClaim = cancelledClaims.find(
      (entry) =>
        entry.item.permissionPromptId === 'prompt:setup:cancelled-before-send',
    );
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
    ).resolves.toBe('prompt_closed');

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

  it('reconciles terminal truth independently from the job projection and expires prompts idempotently', async () => {
    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:exhausted',
      'fp:exhausted',
    );
    const exhaustedSetupState = persistedSetupState(
      'fp:exhausted',
      'fp:exhausted',
    );
    await runtime.service.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({ setupState: exhaustedSetupState })
      .where(
        eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:exhausted'),
      );
    const exhausted = preparation({
      jobId: 'job:setup-prompt:exhausted',
      promptId: 'prompt:setup:exhausted',
      interactionId: 'interaction:setup:exhausted',
      fingerprint: 'fp:exhausted',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      exhausted,
    );
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'failed',
        attemptCount: 4,
        failedAt: later,
        lastError: 'attempts exhausted',
        updatedAt: later,
      })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:exhausted',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({ status: 'failed', settledAt: later, updatedAt: later })
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, exhausted.delivery.id));

    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:ambiguous',
      'fp:ambiguous',
    );
    const ambiguousSetupState = persistedSetupState(
      'fp:ambiguous',
      'fp:ambiguous',
    );
    await runtime.service.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({ setupState: ambiguousSetupState })
      .where(
        eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:ambiguous'),
      );
    const ambiguous = preparation({
      jobId: 'job:setup-prompt:ambiguous',
      promptId: 'prompt:setup:ambiguous',
      interactionId: 'interaction:setup:ambiguous',
      fingerprint: 'fp:ambiguous',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      ambiguous,
    );
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'partially_delivered',
        attemptCount: 1,
        failedAt: later,
        lastError: 'provider outcome unknown',
        updatedAt: later,
      })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:ambiguous',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({
        status: 'partially_delivered',
        settledAt: later,
        updatedAt: later,
      })
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, ambiguous.delivery.id));

    await insertSetupPausedJob(runtime, 'job:setup-prompt:stale', 'fp:stale');
    const stale = preparation({
      jobId: 'job:setup-prompt:stale',
      promptId: 'prompt:setup:stale',
      interactionId: 'interaction:setup:stale',
      fingerprint: 'fp:stale',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      stale,
    );
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'failed',
        attemptCount: 4,
        failedAt: later,
        lastError: 'attempts exhausted',
        updatedAt: later,
      })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:stale',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({ status: 'failed', settledAt: later, updatedAt: later })
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, stale.delivery.id));
    await runtime.service.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({
        setupState: persistedSetupState('fp:newer', 'fp:newer'),
      })
      .where(eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:stale'));

    await insertSetupPausedJob(runtime, 'job:setup-prompt:deleted', 'fp:gone');
    const deleted = preparation({
      jobId: 'job:setup-prompt:deleted',
      promptId: 'prompt:setup:deleted',
      interactionId: 'interaction:setup:deleted',
      fingerprint: 'fp:gone',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      deleted,
    );
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'partially_delivered',
        attemptCount: 1,
        failedAt: later,
        updatedAt: later,
      })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:deleted',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({
        status: 'partially_delivered',
        settledAt: later,
        updatedAt: later,
      })
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, deleted.delivery.id));
    await runtime.service.db
      .delete(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:deleted'));

    await insertSetupPausedJob(
      runtime,
      'job:setup-prompt:cancelled',
      'fp:cancelled',
    );
    const cancelled = preparation({
      jobId: 'job:setup-prompt:cancelled',
      promptId: 'prompt:setup:cancelled',
      interactionId: 'interaction:setup:cancelled',
      fingerprint: 'fp:cancelled',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      cancelled,
    );
    await runtime.service.db
      .update(pgSchema.outboundDeliveryItemsPostgres)
      .set({
        status: 'cancelled',
        cancellationReasonJson: { code: 'target_invalidated' },
        updatedAt: later,
      })
      .where(
        eq(
          pgSchema.outboundDeliveryItemsPostgres.permissionPromptId,
          'prompt:setup:cancelled',
        ),
      );
    await runtime.service.db
      .update(pgSchema.outboundDeliveriesPostgres)
      .set({
        status: 'cancelled',
        cancellationReasonJson: { code: 'target_invalidated' },
        settledAt: later,
        updatedAt: later,
      })
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, cancelled.delivery.id));

    const reconciled = await reconcileSetupPrompts(runtime, later);
    expect(reconciled.terminalDeliveries).toBeGreaterThanOrEqual(5);
    await expect(reconcileSetupPrompts(runtime, later)).resolves.toMatchObject({
      terminalDeliveries: 0,
      expiredPrompts: 0,
    });
    const terminalEvents =
      await runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId: 'default' as never,
        eventTypes: [RUNTIME_EVENT_TYPES.JOB_SETUP_CARD_DELIVERY],
        limit: 100,
      });
    expect(
      terminalEvents.find(
        (event) =>
          event.idempotencyKey ===
          'card_delivery_terminal:prompt:setup:stale:1',
      )?.payload,
    ).toMatchObject({
      outcome: 'exhausted',
      attempt: 4,
      job_id: 'job:setup-prompt:stale',
      setup_fingerprint: 'fp:stale',
    });
    expect(
      terminalEvents.find(
        (event) =>
          event.idempotencyKey ===
          'card_delivery_terminal:prompt:setup:deleted:1',
      )?.payload,
    ).toMatchObject({
      outcome: 'ambiguous',
      job_id: 'job:setup-prompt:deleted',
    });
    const [staleJob] = await runtime.service.db
      .select({ setupState: pgSchema.canonicalJobsPostgres.setupState })
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:stale'));
    expect(staleJob?.setupState).toMatchObject({
      fingerprint: 'fp:newer',
      notified_fingerprint: 'fp:newer',
    });
    const [exhaustedJob] = await runtime.service.db
      .select({ setupState: pgSchema.canonicalJobsPostgres.setupState })
      .from(pgSchema.canonicalJobsPostgres)
      .where(
        eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:exhausted'),
      );
    const [exhaustedPrompt] = await runtime.service.db
      .select({ state: pgSchema.permissionPromptsPostgres.settlementState })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:exhausted'),
      );
    const [exhaustedMember] = await runtime.service.db
      .select({ status: pgSchema.pendingInteractionsPostgres.status })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(
          pgSchema.pendingInteractionsPostgres.envelopeId,
          'prompt:setup:exhausted',
        ),
      );
    expect(exhaustedJob?.setupState).toEqual({
      ...exhaustedSetupState,
      notified_fingerprint: null,
    });
    expect(exhaustedPrompt).toEqual({ state: 'open' });
    expect(exhaustedMember).toEqual({ status: 'pending' });
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        preparation({
          jobId: 'job:setup-prompt:exhausted',
          promptId: 'prompt:setup:exhausted',
          interactionId: 'interaction:setup:exhausted',
          fingerprint: 'fp:exhausted',
        }),
      ),
    ).resolves.toMatchObject({ created: true, generation: 2 });
    const [ambiguousJob] = await runtime.service.db
      .select({ setupState: pgSchema.canonicalJobsPostgres.setupState })
      .from(pgSchema.canonicalJobsPostgres)
      .where(
        eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:ambiguous'),
      );
    const [ambiguousPrompt] = await runtime.service.db
      .select({ state: pgSchema.permissionPromptsPostgres.settlementState })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:ambiguous'),
      );
    const [ambiguousMember] = await runtime.service.db
      .select({ status: pgSchema.pendingInteractionsPostgres.status })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(
          pgSchema.pendingInteractionsPostgres.envelopeId,
          'prompt:setup:ambiguous',
        ),
      );
    expect(ambiguousJob?.setupState).toEqual(ambiguousSetupState);
    expect(ambiguousPrompt).toEqual({ state: 'open' });
    expect(ambiguousMember).toEqual({ status: 'pending' });
    const [cancelledPrompt] = await runtime.service.db
      .select({ state: pgSchema.permissionPromptsPostgres.settlementState })
      .from(pgSchema.permissionPromptsPostgres)
      .where(
        eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:cancelled'),
      );
    const [cancelledMember] = await runtime.service.db
      .select({ status: pgSchema.pendingInteractionsPostgres.status })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(
          pgSchema.pendingInteractionsPostgres.envelopeId,
          'prompt:setup:cancelled',
        ),
      );
    expect(cancelledPrompt).toEqual({ state: 'cancelled' });
    expect(cancelledMember).toEqual({ status: 'cancelled' });

    await insertSetupPausedJob(runtime, 'job:setup-prompt:ttl', 'fp:ttl');
    const expiring = preparation({
      jobId: 'job:setup-prompt:ttl',
      promptId: 'prompt:setup:ttl:a',
      interactionId: 'interaction:setup:ttl:a',
      fingerprint: 'fp:ttl',
    });
    await runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
      expiring,
    );
    await runtime.service.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({
        setupState: persistedSetupState('fp:ttl', 'fp:ttl'),
      })
      .where(eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:ttl'));
    const expired = await reconcileSetupPrompts(
      runtime,
      '2026-08-15T10:00:00.000Z',
    );
    expect(expired.expiredPrompts).toBeGreaterThanOrEqual(1);
    const [expiredPrompt] = await runtime.service.db
      .select({ state: pgSchema.permissionPromptsPostgres.settlementState })
      .from(pgSchema.permissionPromptsPostgres)
      .where(eq(pgSchema.permissionPromptsPostgres.id, 'prompt:setup:ttl:a'));
    const [expiredMember] = await runtime.service.db
      .select({ status: pgSchema.pendingInteractionsPostgres.status })
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(
          pgSchema.pendingInteractionsPostgres.envelopeId,
          'prompt:setup:ttl:a',
        ),
      );
    const [expiryJob] = await runtime.service.db
      .select({ setupState: pgSchema.canonicalJobsPostgres.setupState })
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, 'job:setup-prompt:ttl'));
    expect(expiredPrompt).toEqual({ state: 'expired' });
    expect(expiredMember).toEqual({ status: 'expired' });
    expect(expiryJob?.setupState).toEqual(persistedSetupState('fp:ttl', null));
    await expect(
      reconcileSetupPrompts(runtime, '2026-08-15T10:00:00.000Z'),
    ).resolves.toMatchObject({ expiredPrompts: 0 });
    await expect(
      runtime.repositories.setupPermissionPrompts.prepareSetupPermissionPrompt(
        preparation({
          jobId: 'job:setup-prompt:ttl',
          promptId: 'prompt:setup:ttl:b',
          interactionId: 'interaction:setup:ttl:b',
          fingerprint: 'fp:ttl',
        }),
      ),
    ).resolves.toMatchObject({ created: true, promptId: 'prompt:setup:ttl:b' });
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
    setupState: persistedSetupState(fingerprint, null),
    createdAt: now,
    updatedAt: now,
  });
}

function persistedSetupState(
  fingerprint: string,
  notifiedFingerprint: string | null,
) {
  return {
    state: 'missing_capability',
    checked_at: now,
    fingerprint,
    notified_fingerprint: notifiedFingerprint,
    blockers: [
      {
        state: 'missing_capability',
        type: 'semantic_capability',
        id: 'capability:test.setup',
        summary: 'Test setup capability is missing.',
        action: {
          kind: 'instruction',
          text: 'Install the test setup capability.',
        },
      },
    ],
  } as const;
}

function reconcileSetupPrompts(
  runtime: PostgresIntegrationRuntime,
  reconcileAt: string,
) {
  const repository = runtime.repositories
    .setupPermissionPrompts as typeof runtime.repositories.setupPermissionPrompts & {
    reconcileSetupPermissionPrompts(input: {
      now: string;
    }): Promise<{ terminalDeliveries: number; expiredPrompts: number }>;
  };
  return repository.reconcileSetupPermissionPrompts({ now: reconcileAt });
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

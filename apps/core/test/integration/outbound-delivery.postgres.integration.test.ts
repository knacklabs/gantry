import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { eq } from 'drizzle-orm';
import { PostgresOutboundDeliveryRepository } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.js';
import { OutboundDeliveryService } from '@core/application/outbound-delivery/outbound-delivery-service.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import {
  OutboundDeliveryIdempotencyConflictError,
  type OutboundDelivery,
  type OutboundDeliveryFinalAnswer,
  type OutboundDeliveryItem,
} from '@core/domain/outbound-delivery/outbound-delivery.js';
import { runBoundedOutboundDeliveryRecovery } from '@core/jobs/outbound-delivery-recovery.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function toIsoInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

maybeDescribe('PostgresOutboundDeliveryRepository integration', () => {
  let runtime: PostgresIntegrationRuntime;
  let claimCounter = 0;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'outbound_delivery',
    });
    await runtime.repositories.apps.saveApp({
      id: 'app:other' as never,
      slug: 'other',
      name: 'Other App',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.agents.saveAgent({
      id: 'agent:other' as never,
      appId: 'app:other' as never,
      name: 'Other Agent',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: 'provider-account:outbound' as never,
      appId: 'default' as never,
      agentId: 'agent:main_agent' as never,
      providerId: 'slack' as never,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'T-outbound',
      },
      label: 'Outbound Delivery Account',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: 'provider-account:other' as never,
      appId: 'app:other' as never,
      agentId: 'agent:other' as never,
      providerId: 'slack' as never,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'T-other',
      },
      label: 'Other Account',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveConversation({
      id: 'conversation:outbound' as never,
      appId: 'default' as never,
      providerAccountId: 'provider-account:outbound' as never,
      externalRef: { kind: 'conversation', value: 'C-outbound' },
      kind: 'channel',
      title: 'Outbound Delivery',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveThread({
      id: 'thread:outbound' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      externalRef: { kind: 'conversation_thread', value: 'thread-outbound' },
      title: 'delivery-thread',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveConversation({
      id: 'conversation:other' as never,
      appId: 'app:other' as never,
      providerAccountId: 'provider-account:other' as never,
      externalRef: { kind: 'conversation', value: 'C-other' },
      kind: 'channel',
      title: 'Other Outbound Delivery',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveThread({
      id: 'thread:other' as never,
      appId: 'app:other' as never,
      conversationId: 'conversation:other' as never,
      externalRef: { kind: 'conversation_thread', value: 'thread-other' },
      title: 'other-thread',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('enforces idempotency fingerprint, scoped/ordered claims, token-safe receipts, and retry backoff', async () => {
    const repository = new PostgresOutboundDeliveryRepository(
      runtime.service.db,
      {
        now: () => '2026-05-08T00:00:00.000Z',
        createClaimToken: () => `claim:${++claimCounter}`,
      },
    );

    const delivery: OutboundDelivery = {
      id: 'delivery:outbound:1' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      threadId: 'thread:outbound' as never,
      profileId: 'profile:splitter',
      idempotencyKey: 'idem:outbound:1',
      idempotencyFingerprint: 'fp:outbound:1',
      status: 'pending',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    const finalAnswer: OutboundDeliveryFinalAnswer = {
      deliveryId: delivery.id,
      canonicalText: 'hello world',
      segmentCount: 2,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };
    const items: OutboundDeliveryItem[] = [
      {
        id: 'delivery-item:outbound:1' as never,
        deliveryId: delivery.id,
        ordinal: 0,
        canonicalText: 'hello ',
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: delivery.createdAt,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      },
      {
        id: 'delivery-item:outbound:2' as never,
        deliveryId: delivery.id,
        ordinal: 1,
        canonicalText: 'world',
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: delivery.createdAt,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      },
    ];
    const otherDelivery: OutboundDelivery = {
      ...delivery,
      id: 'delivery:outbound:other' as never,
      profileId: 'profile:other',
      idempotencyKey: 'idem:outbound:other',
      idempotencyFingerprint: 'fp:outbound:other',
    };
    const otherFinalAnswer: OutboundDeliveryFinalAnswer = {
      ...finalAnswer,
      deliveryId: otherDelivery.id,
      canonicalText: 'other',
      segmentCount: 1,
    };
    const otherItems: OutboundDeliveryItem[] = [
      {
        ...items[0]!,
        id: 'delivery-item:outbound:other:1' as never,
        deliveryId: otherDelivery.id,
        canonicalText: 'other',
      },
    ];

    await expect(
      repository.enqueueDelivery({ delivery, finalAnswer, items }),
    ).resolves.toMatchObject({ created: true, delivery: { id: delivery.id } });
    await expect(
      repository.enqueueDelivery({
        delivery: otherDelivery,
        finalAnswer: otherFinalAnswer,
        items: otherItems,
      }),
    ).resolves.toMatchObject({
      created: true,
      delivery: { id: otherDelivery.id },
    });
    await expect(
      repository.enqueueDelivery({ delivery, finalAnswer, items }),
    ).resolves.toMatchObject({ created: false, delivery: { id: delivery.id } });
    await expect(
      repository.enqueueDelivery({
        delivery: {
          ...delivery,
          id: 'delivery:outbound:dup' as never,
          idempotencyFingerprint: 'fp:different',
        },
        finalAnswer,
        items,
      }),
    ).rejects.toBeInstanceOf(OutboundDeliveryIdempotencyConflictError);

    const outOfScopeClaim = await repository.claimDueDeliveryItems({
      appId: 'app:other' as never,
      now: '2026-05-08T00:00:00.000Z',
      claimerId: 'worker:out',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(outOfScopeClaim).toHaveLength(0);

    const firstClaim = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:splitter',
      now: '2026-05-08T00:00:00.000Z',
      claimerId: 'worker:one',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(firstClaim.map((entry) => entry.item.ordinal)).toEqual([0]);

    await expect(
      repository.markDeliveryItemSent({
        deliveryId: delivery.id,
        itemId: firstClaim[0]!.item.id,
        claimToken: 'claim:stale',
        receipt: {
          id: 'receipt:outbound:stale' as never,
          deliveryId: delivery.id,
          itemId: firstClaim[0]!.item.id,
          idempotencyKey: 'receipt-idem:stale',
          providerMessageId: '1710000000.000',
          providerPayload: { provider: 'slack' },
          sentAt: '2026-05-08T00:00:00.500Z',
          createdAt: '2026-05-08T00:00:00.500Z',
        },
      }),
    ).resolves.toMatchObject({ applied: false });
    await expect(
      repository.listReceiptsForItem(firstClaim[0]!.item.id),
    ).resolves.toHaveLength(0);
    await expect(
      repository.markDeliveryItemSent({
        deliveryId: delivery.id,
        itemId: firstClaim[0]!.item.id,
        claimToken: firstClaim[0]!.item.claimToken!,
        receipt: {
          id: 'receipt:outbound:mismatched' as never,
          deliveryId: otherDelivery.id,
          itemId: items[1]!.id,
          idempotencyKey: 'receipt-idem:mismatched',
          providerMessageId: '1710000000.000-mismatch',
          providerPayload: { provider: 'slack' },
          sentAt: '2026-05-08T00:00:00.600Z',
          createdAt: '2026-05-08T00:00:00.600Z',
        },
      }),
    ).resolves.toMatchObject({ applied: false });
    await expect(
      repository.listReceiptsForItem(firstClaim[0]!.item.id),
    ).resolves.toHaveLength(0);
    await expect(
      repository.listReceiptsForItem(items[1]!.id),
    ).resolves.toHaveLength(0);

    const retryPending = await repository.markDeliveryItemFailed({
      deliveryId: delivery.id,
      itemId: firstClaim[0]!.item.id,
      claimToken: firstClaim[0]!.item.claimToken!,
      error: 'provider timeout',
      failedAt: '2026-05-08T00:00:01.000Z',
      maxAttempts: 2,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
    });
    expect(retryPending).toMatchObject({
      applied: true,
      delivery: { status: 'pending' },
    });

    const notDueYet = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:splitter',
      now: '2026-05-08T00:00:01.500Z',
      claimerId: 'worker:two',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(notDueYet).toHaveLength(0);

    const retryClaim = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:splitter',
      now: '2026-05-08T00:00:02.000Z',
      claimerId: 'worker:two',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(retryClaim).toHaveLength(1);
    expect(retryClaim[0]!.item.id).toBe(firstClaim[0]!.item.id);
    expect(retryClaim[0]!.item.attemptCount).toBe(2);

    await expect(
      repository.markDeliveryItemSent({
        deliveryId: delivery.id,
        itemId: retryClaim[0]!.item.id,
        claimToken: retryClaim[0]!.item.claimToken!,
        receipt: {
          id: 'receipt:outbound:1' as never,
          deliveryId: delivery.id,
          itemId: retryClaim[0]!.item.id,
          idempotencyKey: 'receipt-idem:1',
          providerMessageId: '1710000000.001',
          providerPayload: { provider: 'slack' },
          sentAt: '2026-05-08T00:00:02.100Z',
          createdAt: '2026-05-08T00:00:02.100Z',
        },
      }),
    ).resolves.toMatchObject({ applied: true });

    const secondClaim = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:splitter',
      now: '2026-05-08T00:00:02.200Z',
      claimerId: 'worker:three',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0]!.item.ordinal).toBe(1);

    const sentSecond = await repository.markDeliveryItemSent({
      deliveryId: delivery.id,
      itemId: secondClaim[0]!.item.id,
      claimToken: secondClaim[0]!.item.claimToken!,
      receipt: {
        id: 'receipt:outbound:2' as never,
        deliveryId: delivery.id,
        itemId: secondClaim[0]!.item.id,
        idempotencyKey: 'receipt-idem:2',
        providerMessageId: '1710000000.002',
        sentAt: '2026-05-08T00:00:02.300Z',
        createdAt: '2026-05-08T00:00:02.300Z',
      },
    });
    expect(sentSecond).toMatchObject({
      applied: true,
      delivery: { status: 'sent' },
    });

    await expect(
      repository.markDeliveryItemSent({
        deliveryId: delivery.id,
        itemId: secondClaim[0]!.item.id,
        claimToken: 'claim:stale',
        receipt: {
          id: 'receipt:outbound:2' as never,
          deliveryId: delivery.id,
          itemId: secondClaim[0]!.item.id,
          idempotencyKey: 'receipt-idem:2',
          providerMessageId: '1710000000.002',
          sentAt: '2026-05-08T00:00:02.300Z',
          createdAt: '2026-05-08T00:00:02.300Z',
        },
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      repository.markDeliveryItemSent({
        deliveryId: delivery.id,
        itemId: secondClaim[0]!.item.id,
        claimToken: 'claim:stale',
        receipt: {
          id: 'receipt:outbound:2b' as never,
          deliveryId: delivery.id,
          itemId: secondClaim[0]!.item.id,
          idempotencyKey: 'receipt-idem:new',
          providerMessageId: '1710000000.099',
          sentAt: '2026-05-08T00:00:02.900Z',
          createdAt: '2026-05-08T00:00:02.900Z',
        },
      }),
    ).resolves.toMatchObject({ applied: false });

    const finalDelivery = await repository.getDelivery(delivery.id);
    expect(finalDelivery?.status).toBe('sent');
    const otherProfileClaim = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:other',
      now: '2026-05-08T00:00:03.000Z',
      claimerId: 'worker:other',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(otherProfileClaim).toHaveLength(1);
    expect(otherProfileClaim[0]!.delivery.id).toBe(otherDelivery.id);
    await expect(
      repository.markDeliveryItemPartiallyDelivered({
        deliveryId: otherDelivery.id,
        itemId: otherProfileClaim[0]!.item.id,
        claimToken: otherProfileClaim[0]!.item.claimToken!,
        error: 'mid-stream partial visibility',
        deliveredParts: 1,
        totalParts: 2,
        partialAt: '2026-05-08T00:00:03.100Z',
      }),
    ).resolves.toMatchObject({
      applied: true,
      delivery: { status: 'partially_delivered' },
    });
    const noBlindResendClaim = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:other',
      now: '2026-05-08T00:00:06.000Z',
      claimerId: 'worker:other',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(noBlindResendClaim).toHaveLength(0);

    const deliveryRow = await runtime.service.db
      .select()
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, delivery.id))
      .limit(1);
    expect(deliveryRow[0]).toMatchObject({
      idempotencyFingerprint: 'fp:outbound:1',
    });
  });

  it('rejects cross-app ownership on enqueue and blocks forged cross-app claims', async () => {
    const repository = new PostgresOutboundDeliveryRepository(
      runtime.service.db,
    );
    await expect(
      repository.resolveDeliveryDestination({
        appId: 'default' as never,
        conversationId: 'conversation:outbound' as never,
        threadId: 'thread:outbound' as never,
      }),
    ).resolves.toEqual({
      conversationJid: 'sl:C-outbound',
      threadId: 'thread-outbound',
      providerId: 'slack',
      providerAccountId: 'provider-account:outbound',
    });
    await runtime.repositories.conversations.saveThread({
      id: 'thread:missing-ref' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      title: 'missing-ref',
      status: 'active',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    await expect(
      repository.resolveDeliveryDestination({
        appId: 'default' as never,
        conversationId: 'conversation:outbound' as never,
        threadId: 'thread:missing-ref' as never,
      }),
    ).resolves.toBeNull();

    const baseDelivery: OutboundDelivery = {
      id: 'delivery:ownership:1' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      profileId: 'profile:splitter',
      idempotencyKey: 'idem:ownership:1',
      idempotencyFingerprint: 'fp:ownership:1',
      status: 'pending',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    const finalAnswer: OutboundDeliveryFinalAnswer = {
      deliveryId: baseDelivery.id,
      canonicalText: 'ownership test',
      segmentCount: 1,
      createdAt: baseDelivery.createdAt,
      updatedAt: baseDelivery.updatedAt,
    };
    const item: OutboundDeliveryItem = {
      id: 'delivery-item:ownership:1' as never,
      deliveryId: baseDelivery.id,
      ordinal: 0,
      canonicalText: 'ownership test',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: baseDelivery.createdAt,
      createdAt: baseDelivery.createdAt,
      updatedAt: baseDelivery.updatedAt,
    };

    await expect(
      repository.enqueueDelivery({
        delivery: {
          ...baseDelivery,
          conversationId: 'conversation:other' as never,
          id: 'delivery:ownership:bad-conversation' as never,
          idempotencyKey: 'idem:ownership:bad-conversation',
          idempotencyFingerprint: 'fp:ownership:bad-conversation',
        },
        finalAnswer: {
          ...finalAnswer,
          deliveryId: 'delivery:ownership:bad-conversation' as never,
        },
        items: [
          {
            ...item,
            id: 'delivery-item:ownership:bad-conversation' as never,
            deliveryId: 'delivery:ownership:bad-conversation' as never,
          },
        ],
      }),
    ).rejects.toThrow(/not owned/i);

    await expect(
      repository.enqueueDelivery({
        delivery: {
          ...baseDelivery,
          threadId: 'thread:other' as never,
          id: 'delivery:ownership:bad-thread' as never,
          idempotencyKey: 'idem:ownership:bad-thread',
          idempotencyFingerprint: 'fp:ownership:bad-thread',
        },
        finalAnswer: {
          ...finalAnswer,
          deliveryId: 'delivery:ownership:bad-thread' as never,
        },
        items: [
          {
            ...item,
            id: 'delivery-item:ownership:bad-thread' as never,
            deliveryId: 'delivery:ownership:bad-thread' as never,
          },
        ],
      }),
    ).rejects.toThrow(/not owned/i);

    await runtime.service.db
      .insert(pgSchema.outboundDeliveriesPostgres)
      .values({
        id: 'delivery:ownership:forged',
        appId: 'default',
        conversationId: 'conversation:other',
        profileId: 'profile:splitter',
        idempotencyKey: 'idem:ownership:forged',
        idempotencyFingerprint: 'fp:ownership:forged',
        status: 'pending',
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
      });
    await runtime.service.db
      .insert(pgSchema.outboundDeliveryFinalAnswersPostgres)
      .values({
        deliveryId: 'delivery:ownership:forged',
        canonicalText: 'forged',
        segmentCount: 1,
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
      });
    await runtime.service.db
      .insert(pgSchema.outboundDeliveryItemsPostgres)
      .values({
        id: 'delivery-item:ownership:forged',
        deliveryId: 'delivery:ownership:forged',
        ordinal: 0,
        canonicalText: 'forged',
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: '2026-05-08T00:00:00.000Z',
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
      });

    const claimed = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:splitter',
      now: '2026-05-08T00:00:00.000Z',
      claimerId: 'worker:ownership',
      leaseMs: 5_000,
      limit: 10,
    });
    expect(
      claimed.some(
        (row) => row.delivery.id === ('delivery:ownership:forged' as never),
      ),
    ).toBe(false);
  });

  it('claims due outbound rows across app scopes when appId is omitted', async () => {
    const repository = new PostgresOutboundDeliveryRepository(
      runtime.service.db,
      {
        now: () => '2026-05-08T00:00:00.000Z',
        createClaimToken: () => `claim:global:${++claimCounter}`,
      },
    );
    const delivery: OutboundDelivery = {
      id: 'delivery:global-claim:1' as never,
      appId: 'app:other' as never,
      conversationId: 'conversation:other' as never,
      profileId: 'profile:global',
      idempotencyKey: 'idem:global-claim:1',
      idempotencyFingerprint: 'fp:global-claim:1',
      status: 'pending',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    const finalAnswer: OutboundDeliveryFinalAnswer = {
      deliveryId: delivery.id,
      canonicalText: 'cross-app claim',
      segmentCount: 1,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };
    const item: OutboundDeliveryItem = {
      id: 'delivery-item:global-claim:1' as never,
      deliveryId: delivery.id,
      ordinal: 0,
      canonicalText: 'cross-app claim',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: delivery.createdAt,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };

    await repository.enqueueDelivery({
      delivery,
      finalAnswer,
      items: [item],
    });

    const claimed = await repository.claimDueDeliveryItems({
      now: '2026-05-08T00:00:00.000Z',
      claimerId: 'runtime-recovery:global',
      leaseMs: 1_000,
      limit: 5,
    });

    expect(claimed).toEqual([
      expect.objectContaining({
        delivery: expect.objectContaining({
          id: 'delivery:global-claim:1',
          appId: 'app:other',
        }),
        item: expect.objectContaining({
          id: 'delivery-item:global-claim:1',
        }),
      }),
    ]);
  });

  it('marks visible-send settlement failures as non-reclaimable partial ambiguity', async () => {
    const repository = new PostgresOutboundDeliveryRepository(
      runtime.service.db,
    );

    const delivery: OutboundDelivery = {
      id: 'delivery:ambiguous:sent-settlement' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      profileId: 'profile:live-send',
      idempotencyKey: 'idem:ambiguous:sent-settlement',
      idempotencyFingerprint: 'fp:ambiguous:sent-settlement',
      status: 'pending',
      createdAt: '2026-05-08T01:00:00.000Z',
      updatedAt: '2026-05-08T01:00:00.000Z',
    };
    const finalAnswer: OutboundDeliveryFinalAnswer = {
      deliveryId: delivery.id,
      canonicalText: 'visible provider message',
      segmentCount: 1,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };
    const claimToken = 'claim:ambiguous:sent-settlement';
    const items: OutboundDeliveryItem[] = [
      {
        id: 'delivery-item:ambiguous:sent-settlement' as never,
        deliveryId: delivery.id,
        ordinal: 0,
        canonicalText: 'visible provider message',
        status: 'claimed',
        attemptCount: 1,
        claimToken,
        claimExpiresAt: '2026-05-08T01:00:30.000Z',
        nextAttemptAt: delivery.createdAt,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      },
    ];

    await repository.enqueueDelivery({ delivery, finalAnswer, items });

    await expect(
      repository.markDeliveryItemSent({
        deliveryId: delivery.id,
        itemId: items[0]!.id,
        claimToken: 'claim:stale-token',
        receipt: {
          id: 'receipt:ambiguous:stale' as never,
          deliveryId: delivery.id,
          itemId: items[0]!.id,
          idempotencyKey: 'receipt-idem:ambiguous:stale',
          providerMessageId: '1710000000.ambiguous',
          sentAt: '2026-05-08T01:00:10.000Z',
          createdAt: '2026-05-08T01:00:10.000Z',
        },
      }),
    ).resolves.toMatchObject({ applied: false });

    await expect(
      repository.markDeliveryItemPartiallyDelivered({
        deliveryId: delivery.id,
        itemId: items[0]!.id,
        claimToken,
        error:
          'Provider send succeeded but durable sent-status persistence failed. Delivery may already be visible and cannot be blindly retried.',
        partialAt: '2026-05-08T01:00:10.100Z',
      }),
    ).resolves.toMatchObject({
      applied: true,
      delivery: { status: 'partially_delivered' },
    });

    const reclaimAttempt = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'profile:live-send',
      now: '2026-05-08T01:10:00.000Z',
      claimerId: 'worker:reclaim-check',
      leaseMs: 1_000,
      limit: 1,
    });
    expect(reclaimAttempt).toHaveLength(0);

    const itemRows = await runtime.service.db
      .select()
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(eq(pgSchema.outboundDeliveryItemsPostgres.id, items[0]!.id))
      .limit(1);
    expect(itemRows[0]).toMatchObject({
      status: 'partially_delivered',
      claimToken: null,
      claimExpiresAt: null,
    });
  });

  it('does not blindly redispatch expired initial live-send claims after provider-visible crash windows', async () => {
    const repository = new PostgresOutboundDeliveryRepository(
      runtime.service.db,
    );
    const delivery: OutboundDelivery = {
      id: 'delivery:ambiguous:initial-live-send-expired' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      profileId: 'runtime.live_send.v1',
      idempotencyKey: 'idem:ambiguous:initial-live-send-expired',
      idempotencyFingerprint: 'fp:ambiguous:initial-live-send-expired',
      status: 'pending',
      createdAt: '2026-05-08T02:00:00.000Z',
      updatedAt: '2026-05-08T02:00:00.000Z',
    };
    const finalAnswer: OutboundDeliveryFinalAnswer = {
      deliveryId: delivery.id,
      canonicalText: 'provider-visible text',
      segmentCount: 1,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };
    const items: OutboundDeliveryItem[] = [
      {
        id: 'delivery-item:ambiguous:initial-live-send-expired' as never,
        deliveryId: delivery.id,
        ordinal: 0,
        canonicalText: 'provider-visible text',
        status: 'claimed',
        attemptCount: 1,
        claimToken: 'claim:live-send:source-message',
        claimExpiresAt: '2026-05-08T02:00:30.000Z',
        nextAttemptAt: '2026-05-08T02:00:00.000Z',
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      },
    ];

    await repository.enqueueDelivery({ delivery, finalAnswer, items });

    const service = new OutboundDeliveryService({
      repository,
      profiles: {
        resolve: () => ({
          profileId: 'runtime.live_send.v1',
          plan: () => ({
            parts: [{ canonicalText: 'provider-visible text' }],
            canonicalFinalText: 'provider-visible text',
          }),
        }),
      },
      now: () => '2026-05-08T02:10:00.000Z',
      createId: () => 'unused-id',
      hashSha256Hex: (value: string) => value,
    });
    const dispatch = vi.fn(async () => ({
      status: 'sent' as const,
      providerMessageId: 'should-not-send',
    }));
    const recovery = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'default' as never,
      claimerId: 'worker:crash-window',
      batchLimit: 5,
      maxBatches: 2,
      leaseMs: 10_000,
      now: () => '2026-05-08T02:10:00.000Z',
      dispatch,
    });

    expect(recovery.claimed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();

    const itemRows = await runtime.service.db
      .select()
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(eq(pgSchema.outboundDeliveryItemsPostgres.id, items[0]!.id))
      .limit(1);
    expect(itemRows[0]).toMatchObject({
      status: 'partially_delivered',
      claimToken: null,
      claimExpiresAt: null,
      lastError: expect.stringContaining(
        'automatic retry was disabled to avoid blind redispatch',
      ),
    });
    expect(toIsoInstant(itemRows[0]?.failedAt)).toBe(
      '2026-05-08T02:10:00.000Z',
    );

    const deliveryRows = await runtime.service.db
      .select()
      .from(pgSchema.outboundDeliveriesPostgres)
      .where(eq(pgSchema.outboundDeliveriesPostgres.id, delivery.id))
      .limit(1);
    expect(deliveryRows[0]).toMatchObject({
      status: 'partially_delivered',
      lastError: expect.stringContaining(
        'automatic retry was disabled to avoid blind redispatch',
      ),
    });
    expect(toIsoInstant(deliveryRows[0]?.settledAt)).toBe(
      '2026-05-08T02:10:00.000Z',
    );
  });

  it('does not blindly redispatch expired recovery-owned claims after provider-dispatch crash windows', async () => {
    const repository = new PostgresOutboundDeliveryRepository(
      runtime.service.db,
      {
        now: () => '2026-05-08T03:00:00.000Z',
        createClaimToken: () => 'claim:recovery-owned',
      },
    );
    const delivery: OutboundDelivery = {
      id: 'delivery:ambiguous:recovery-owned-expired' as never,
      appId: 'default' as never,
      conversationId: 'conversation:outbound' as never,
      profileId: 'runtime.retry_tail_suffix.v1',
      idempotencyKey: 'idem:ambiguous:recovery-owned-expired',
      idempotencyFingerprint: 'fp:ambiguous:recovery-owned-expired',
      status: 'pending',
      createdAt: '2026-05-08T03:00:00.000Z',
      updatedAt: '2026-05-08T03:00:00.000Z',
    };
    const finalAnswer: OutboundDeliveryFinalAnswer = {
      deliveryId: delivery.id,
      canonicalText: 'provider-visible retry tail',
      segmentCount: 1,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };
    const items: OutboundDeliveryItem[] = [
      {
        id: 'delivery-item:ambiguous:recovery-owned-expired' as never,
        deliveryId: delivery.id,
        ordinal: 0,
        canonicalText: 'provider-visible retry tail',
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: '2026-05-08T03:00:00.000Z',
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      },
    ];

    await repository.enqueueDelivery({ delivery, finalAnswer, items });
    const firstClaim = await repository.claimDueDeliveryItems({
      appId: 'default' as never,
      profileId: 'runtime.retry_tail_suffix.v1',
      now: '2026-05-08T03:00:00.000Z',
      claimerId: 'runtime-recovery:initial',
      leaseMs: 5_000,
      limit: 1,
    });
    expect(firstClaim).toHaveLength(1);

    const service = new OutboundDeliveryService({
      repository,
      profiles: {
        resolve: () => undefined,
      },
      now: () => '2026-05-08T03:10:00.000Z',
      createId: () => 'unused-id',
      hashSha256Hex: (value) => value,
    });
    const dispatch = vi.fn(async () => ({
      status: 'sent' as const,
      providerMessageId: 'should-not-send',
    }));
    const recovery = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'default' as never,
      claimerId: 'runtime-recovery:restart',
      batchLimit: 5,
      maxBatches: 2,
      leaseMs: 5_000,
      now: () => '2026-05-08T03:10:00.000Z',
      dispatch,
    });

    expect(recovery.claimed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();

    const itemRows = await runtime.service.db
      .select()
      .from(pgSchema.outboundDeliveryItemsPostgres)
      .where(eq(pgSchema.outboundDeliveryItemsPostgres.id, items[0]!.id))
      .limit(1);
    expect(itemRows[0]).toMatchObject({
      status: 'partially_delivered',
      claimToken: null,
      claimOwner: null,
      claimExpiresAt: null,
      lastError: expect.stringContaining(
        'automatic retry was disabled to avoid blind redispatch',
      ),
    });
  });
});

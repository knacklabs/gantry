import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { OutboundDeliveryService } from '@core/application/outbound-delivery/outbound-delivery-service.js';
import { ApplicationError } from '@core/application/common/application-error.js';
import { OutboundDeliveryIdempotencyConflictError } from '@core/domain/outbound-delivery/outbound-delivery.js';
import type {
  OutboundDeliveryPlanInput,
  OutboundDeliveryProfile,
} from '@core/domain/outbound-delivery/planner.js';
import type { OutboundDeliveryRepository } from '@core/domain/ports/repositories.js';

const hashSha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

class MemoryProfileRegistry {
  constructor(private readonly profile?: OutboundDeliveryProfile) {}
  resolve(profileId: string) {
    return this.profile?.profileId === profileId ? this.profile : undefined;
  }
}

class MemoryOutboundDeliveryRepository implements OutboundDeliveryRepository {
  enqueues: Array<
    Parameters<OutboundDeliveryRepository['enqueueDelivery']>[0]
  > = [];
  claims: Array<
    Parameters<OutboundDeliveryRepository['claimDueDeliveryItems']>[0]
  > = [];
  failures: Array<
    Parameters<OutboundDeliveryRepository['markDeliveryItemFailed']>[0]
  > = [];
  sentSettlements: Array<
    Parameters<OutboundDeliveryRepository['markDeliveryItemSent']>[0]
  > = [];
  partialSettlements: Array<
    Parameters<
      OutboundDeliveryRepository['markDeliveryItemPartiallyDelivered']
    >[0]
  > = [];
  conflictOnEnqueue = false;

  async enqueueDelivery(
    input: Parameters<OutboundDeliveryRepository['enqueueDelivery']>[0],
  ) {
    if (this.conflictOnEnqueue) {
      throw new OutboundDeliveryIdempotencyConflictError('conflict');
    }
    this.enqueues.push(input);
    return { created: true, delivery: input.delivery };
  }

  async getDelivery() {
    return null;
  }

  async claimDueDeliveryItems(
    input: Parameters<OutboundDeliveryRepository['claimDueDeliveryItems']>[0],
  ) {
    this.claims.push(input);
    return [];
  }

  async resolveDeliveryDestination() {
    return null;
  }

  async markDeliveryItemSent(
    input: Parameters<OutboundDeliveryRepository['markDeliveryItemSent']>[0],
  ) {
    this.sentSettlements.push(input);
    return { applied: true, delivery: null };
  }

  async markDeliveryItemFailed(
    input: Parameters<OutboundDeliveryRepository['markDeliveryItemFailed']>[0],
  ) {
    this.failures.push(input);
    return { applied: true, delivery: null };
  }

  async markDeliveryItemPartiallyDelivered(
    input: Parameters<
      OutboundDeliveryRepository['markDeliveryItemPartiallyDelivered']
    >[0],
  ) {
    this.partialSettlements.push(input);
    return { applied: true, delivery: null };
  }

  async listReceiptsForItem() {
    return [];
  }

  async getReceipt() {
    return null;
  }
}

function createProfile(
  planFactory: (input: OutboundDeliveryPlanInput) => {
    parts: Array<{ canonicalText: string; providerPayload?: unknown }>;
    canonicalFinalText?: string;
  },
): OutboundDeliveryProfile {
  return {
    profileId: 'profile:test',
    plan: vi.fn(async (input: OutboundDeliveryPlanInput) => planFactory(input)),
  };
}

describe('OutboundDeliveryService', () => {
  it('enqueues ordered segments and canonical final text from plan output', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const profile = createProfile(() => ({
      parts: [
        { canonicalText: 'Hello ' },
        { canonicalText: 'world', providerPayload: { channel: 'slack' } },
      ],
      canonicalFinalText: 'Hello world',
    }));
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(profile),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    const result = await service.enqueue({
      appId: 'app:test' as never,
      conversationId: 'conversation:test' as never,
      profileId: 'profile:test',
      idempotencyKey: 'idem:test',
      text: 'ignored raw text',
    });

    expect(result.created).toBe(true);
    expect(repository.enqueues).toHaveLength(1);
    expect(repository.enqueues[0]!.finalAnswer).toMatchObject({
      canonicalText: 'Hello world',
      segmentCount: 2,
    });
    expect(repository.enqueues[0]!.delivery.idempotencyFingerprint).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(repository.enqueues[0]!.items).toEqual([
      expect.objectContaining({
        ordinal: 0,
        canonicalText: 'Hello ',
      }),
      expect.objectContaining({
        ordinal: 1,
        canonicalText: 'world',
        providerPayload: undefined,
      }),
    ]);
  });

  it('can enqueue a single delivery item as initially claimed for immediate durable sends', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const profile = createProfile(() => ({
      parts: [{ canonicalText: 'hello' }],
      canonicalFinalText: 'hello',
    }));
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(profile),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    const result = await service.enqueue({
      appId: 'app:test' as never,
      conversationId: 'conversation:test' as never,
      profileId: 'profile:test',
      idempotencyKey: 'idem:claimed',
      text: 'hello',
      initialClaim: {
        claimToken: 'claim:immediate',
        claimExpiresAt: '2026-05-08T00:01:00.000Z',
      },
    });

    expect(result.claimedItem).toEqual({
      itemId: 'delivery-item:seed-id',
      claimToken: 'claim:immediate',
    });
    expect(result.claimedItems).toEqual([
      {
        itemId: 'delivery-item:seed-id',
        claimToken: 'claim:immediate',
      },
    ]);
    expect(repository.enqueues[0]!.items[0]).toMatchObject({
      status: 'claimed',
      attemptCount: 1,
      claimToken: 'claim:immediate',
      claimExpiresAt: '2026-05-08T00:01:00.000Z',
    });
  });

  it('builds canonical final text by concatenating normalized segments when plan omits it', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const profile = createProfile(() => ({
      parts: [{ canonicalText: '  one  ' }, { canonicalText: 'two\r\n' }],
    }));
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(profile),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await service.enqueue({
      appId: 'app:test' as never,
      conversationId: 'conversation:test' as never,
      profileId: 'profile:test',
      idempotencyKey: 'idem:test',
      text: 'raw',
    });

    expect(repository.enqueues[0]!.finalAnswer.canonicalText).toBe(
      '  one  two\n',
    );
  });

  it('enforces planner boundaries for empty plans and oversize segments', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const emptyPlanProfile = createProfile(() => ({ parts: [] }));
    const serviceForEmptyPlan = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(emptyPlanProfile),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await expect(
      serviceForEmptyPlan.enqueue({
        appId: 'app:test' as never,
        conversationId: 'conversation:test' as never,
        profileId: 'profile:test',
        idempotencyKey: 'idem:test',
        text: 'raw',
      }),
    ).rejects.toMatchObject<ApplicationError>({
      code: 'INVALID_REQUEST',
    });

    const longSegmentProfile = createProfile(() => ({
      parts: [{ canonicalText: '123456' }],
    }));
    const serviceForLongSegment = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(longSegmentProfile),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await expect(
      serviceForLongSegment.enqueue({
        appId: 'app:test' as never,
        conversationId: 'conversation:test' as never,
        profileId: 'profile:test',
        idempotencyKey: 'idem:test',
        text: 'raw',
        maxSegmentChars: 5,
      }),
    ).rejects.toMatchObject<ApplicationError>({
      code: 'INVALID_REQUEST',
    });
  });

  it('enforces canonical final text length caps', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const profile = createProfile(() => ({
      parts: [{ canonicalText: 'ok' }],
      canonicalFinalText: 'too long',
    }));
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(profile),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await expect(
      service.enqueue({
        appId: 'app:test' as never,
        conversationId: 'conversation:test' as never,
        profileId: 'profile:test',
        idempotencyKey: 'idem:test',
        text: 'raw',
        maxFinalTextChars: 3,
      }),
    ).rejects.toMatchObject<ApplicationError>({
      code: 'INVALID_REQUEST',
    });
  });

  it('rejects unknown delivery profiles', async () => {
    const service = new OutboundDeliveryService({
      repository: new MemoryOutboundDeliveryRepository(),
      profiles: new MemoryProfileRegistry(),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await expect(
      service.enqueue({
        appId: 'app:test' as never,
        conversationId: 'conversation:test' as never,
        profileId: 'profile:missing',
        idempotencyKey: 'idem:test',
        text: 'raw',
      }),
    ).rejects.toMatchObject<ApplicationError>({
      code: 'INVALID_REQUEST',
    });
  });

  it('rejects blank idempotency keys', async () => {
    const service = new OutboundDeliveryService({
      repository: new MemoryOutboundDeliveryRepository(),
      profiles: new MemoryProfileRegistry(
        createProfile(() => ({ parts: [{ canonicalText: 'x' }] })),
      ),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await expect(
      service.enqueue({
        appId: 'app:test' as never,
        conversationId: 'conversation:test' as never,
        profileId: 'profile:test',
        idempotencyKey: '   ',
        text: 'raw',
      }),
    ).rejects.toMatchObject<ApplicationError>({ code: 'INVALID_REQUEST' });
  });

  it('returns conflict when idempotent retries mismatch payload fingerprint', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    repository.conflictOnEnqueue = true;
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(
        createProfile(() => ({ parts: [{ canonicalText: 'x' }] })),
      ),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await expect(
      service.enqueue({
        appId: 'app:test' as never,
        conversationId: 'conversation:test' as never,
        profileId: 'profile:test',
        idempotencyKey: 'idem:test',
        text: 'raw',
      }),
    ).rejects.toMatchObject<ApplicationError>({ code: 'CONFLICT' });
  });

  it('passes app/profile claim scope and retry policy defaults to repository', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(
        createProfile(() => ({ parts: [{ canonicalText: 'x' }] })),
      ),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await service.claimPending({
      appId: 'app:test' as never,
      profileId: 'profile:test',
      claimerId: 'worker:test',
      limit: 1,
    });
    await service.settleFailed({
      deliveryId: 'delivery:test' as never,
      itemId: 'delivery-item:test' as never,
      claimToken: 'claim:test',
      error: 'timeout',
      failedAt: '2026-05-08T00:00:01.000Z',
    });

    expect(repository.claims[0]).toMatchObject({
      appId: 'app:test',
      profileId: 'profile:test',
      claimerId: 'worker:test',
      limit: 1,
    });
    expect(repository.failures[0]).toMatchObject({
      maxAttempts: 4,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    });
  });

  it('can claim pending deliveries across all app scopes', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(
        createProfile(() => ({ parts: [{ canonicalText: 'x' }] })),
      ),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await service.claimPendingAcrossApps({
      profileId: 'profile:test',
      claimerId: 'worker:global',
      limit: 2,
    });

    expect(repository.claims[0]).toMatchObject({
      profileId: 'profile:test',
      claimerId: 'worker:global',
      limit: 2,
    });
    expect(repository.claims[0]).not.toHaveProperty('appId');
  });

  it('sanitizes provider payloads before persisting receipts and retry tails', async () => {
    const repository = new MemoryOutboundDeliveryRepository();
    const service = new OutboundDeliveryService({
      repository,
      profiles: new MemoryProfileRegistry(
        createProfile(() => ({ parts: [{ canonicalText: 'x' }] })),
      ),
      now: () => '2026-05-08T00:00:00.000Z',
      createId: () => 'seed-id',
      hashSha256Hex,
    });

    await service.settleSent({
      deliveryId: 'delivery:test' as never,
      itemId: 'delivery-item:test' as never,
      claimToken: 'claim:test',
      receiptIdempotencyKey: 'receipt:test',
      providerPayload: {
        provider: 'slack',
        channelId: 'C123',
        text: 'drop',
        apiToken: 'drop',
      },
    });
    await service.settlePartiallyDelivered({
      deliveryId: 'delivery:test' as never,
      itemId: 'delivery-item:test' as never,
      claimToken: 'claim:test',
      error: 'partial',
      retryTail: {
        canonicalText: 'tail',
        providerPayload: {
          provider: 'slack',
          threadId: '171.222',
          unknown: 'drop',
          fullText: 'drop',
        },
      },
    });

    expect(repository.sentSettlements[0]?.receipt.providerPayload).toEqual({
      provider: 'slack',
      channelId: 'C123',
    });
    expect(
      repository.partialSettlements[0]?.retryTail?.providerPayload,
    ).toEqual({
      provider: 'slack',
      threadId: '171.222',
    });
  });
});

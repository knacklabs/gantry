import { describe, expect, it } from 'vitest';

import { PostgresOutboundDeliveryRepository } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.js';
import { deriveOutboundDeliveryStatus } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.helpers.js';
import {
  OutboundDeliveryIdempotencyConflictError,
  type OutboundDelivery,
  type OutboundDeliveryFinalAnswer,
  type OutboundDeliveryItem,
} from '@core/domain/outbound-delivery/outbound-delivery.js';

class FakeDb {
  selectCalls = 0;
  insertCalls = 0;

  constructor(private readonly existingFingerprint: string) {}

  async transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  select() {
    this.selectCalls += 1;
    const row = {
      id: 'delivery:existing',
      appId: 'app:test',
      conversationId: 'conversation:test',
      threadId: null,
      agentId: null,
      runId: null,
      profileId: 'profile:test',
      idempotencyKey: 'idem:test',
      idempotencyFingerprint: this.existingFingerprint,
      status: 'pending',
      settledAt: null,
      lastError: null,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    return {
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    };
  }

  insert() {
    this.insertCalls += 1;
    throw new Error(
      'insert should not run when idempotency key already exists',
    );
  }
}

function createInput(fingerprint = 'fp:test') {
  const delivery: OutboundDelivery = {
    id: 'delivery:new' as never,
    appId: 'app:test' as never,
    conversationId: 'conversation:test' as never,
    profileId: 'profile:test',
    idempotencyKey: 'idem:test',
    idempotencyFingerprint: fingerprint,
    status: 'pending',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
  };
  const finalAnswer: OutboundDeliveryFinalAnswer = {
    deliveryId: delivery.id,
    canonicalText: 'hi',
    segmentCount: 1,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
  const item: OutboundDeliveryItem = {
    id: 'delivery-item:new' as never,
    deliveryId: delivery.id,
    ordinal: 0,
    canonicalText: 'hi',
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: delivery.createdAt,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
  return { delivery, finalAnswer, items: [item] };
}

describe('PostgresOutboundDeliveryRepository', () => {
  describe('deriveOutboundDeliveryStatus', () => {
    it('treats earliest terminal unsent failure as terminal even with later pending segments', () => {
      const status = deriveOutboundDeliveryStatus({
        counts: {
          pending: 1,
          claimed: 0,
          sent: 0,
          failed: 1,
          partiallyDelivered: 0,
        },
        earliestUnsentStatus: 'failed',
      });

      expect(status).toBe('failed');
    });

    it('treats earliest terminal partial as terminal even with later pending segments', () => {
      const status = deriveOutboundDeliveryStatus({
        counts: {
          pending: 2,
          claimed: 0,
          sent: 0,
          failed: 0,
          partiallyDelivered: 1,
        },
        earliestUnsentStatus: 'partially_delivered',
      });

      expect(status).toBe('partially_delivered');
    });

    it('keeps retryable work pending when earliest unsent is pending', () => {
      const status = deriveOutboundDeliveryStatus({
        counts: {
          pending: 1,
          claimed: 0,
          sent: 0,
          failed: 0,
          partiallyDelivered: 0,
        },
        earliestUnsentStatus: 'pending',
      });

      expect(status).toBe('pending');
    });
  });

  it('returns existing delivery for idempotent enqueue retries', async () => {
    const db = new FakeDb('fp:test');
    const repository = new PostgresOutboundDeliveryRepository(db as never);

    const result = await repository.enqueueDelivery(createInput('fp:test'));

    expect(result).toMatchObject({
      created: false,
      delivery: {
        id: 'delivery:existing',
        idempotencyKey: 'idem:test',
        idempotencyFingerprint: 'fp:test',
      },
    });
    expect(db.selectCalls).toBe(2);
    expect(db.insertCalls).toBe(0);
  });

  it('throws idempotency conflict when retry payload fingerprint mismatches', async () => {
    const db = new FakeDb('fp:existing');
    const repository = new PostgresOutboundDeliveryRepository(db as never);

    await expect(
      repository.enqueueDelivery(createInput('fp:new')),
    ).rejects.toBeInstanceOf(OutboundDeliveryIdempotencyConflictError);
    expect(db.selectCalls).toBe(2);
    expect(db.insertCalls).toBe(0);
  });
});

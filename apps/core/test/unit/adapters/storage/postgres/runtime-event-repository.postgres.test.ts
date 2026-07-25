import { describe, expect, it } from 'vitest';

import { PostgresRuntimeEventRepository } from '@core/adapters/storage/postgres/repositories/runtime-event-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

class FakeDrizzleDb {
  readonly operations: string[] = [];
  insertedRuntimeEvent: Record<string, unknown> | null = null;
  insertedOutboxEvent: Record<string, unknown> | null = null;
  insertedConversationThread: Record<string, unknown> | null = null;
  failOutboxInsert = false;
  failDeliveryInsert = false;

  async transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    this.operations.push('transaction:begin');
    try {
      const result = await fn(this);
      this.operations.push('transaction:commit');
      return result;
    } catch (err) {
      this.operations.push('transaction:rollback');
      throw err;
    }
  }

  insert(table: unknown) {
    const db = this;
    return {
      values(value: Record<string, unknown>) {
        if (table === pgSchema.runtimeEventsPostgres) {
          db.operations.push('insert:runtime_events');
          db.insertedRuntimeEvent = value;
          return {
            async returning() {
              return [
                {
                  eventId: 42,
                  appId: value.appId,
                  agentId: null,
                  sessionId: value.sessionId,
                  runId: null,
                  jobId: null,
                  triggerId: null,
                  conversationId: null,
                  threadId: null,
                  eventType: value.eventType,
                  actor: value.actor,
                  correlationId: null,
                  responseMode: value.responseMode,
                  webhookId: value.webhookId,
                  payloadJson: value.payloadJson,
                  createdAt: value.createdAt,
                },
              ];
            },
          };
        }
        if (table === pgSchema.eventBusOutboxPostgres) {
          db.operations.push('insert:event_bus_outbox');
          db.insertedOutboxEvent = value;
          return {
            onConflictDoNothing() {
              if (db.failOutboxInsert) {
                throw new Error('outbox insert failed');
              }
              return Promise.resolve();
            },
          };
        }
        if (table === pgSchema.conversationThreadsPostgres) {
          db.operations.push('insert:conversation_threads');
          db.insertedConversationThread = value;
          return {
            onConflictDoNothing() {
              return Promise.resolve();
            },
          };
        }
        if (table === pgSchema.controlHttpWebhookDeliveriesPostgres) {
          db.operations.push('insert:webhook_delivery');
          return {
            onConflictDoNothing() {
              if (db.failDeliveryInsert) {
                throw new Error('delivery insert failed');
              }
              return Promise.resolve();
            },
          };
        }
        throw new Error('Unexpected insert table');
      },
    };
  }

  select() {
    const db = this;
    return {
      from(table: unknown) {
        if (table !== pgSchema.controlHttpWebhooksPostgres) {
          throw new Error('Unexpected select table');
        }
        db.operations.push('select:webhook');
        return {
          where() {
            return {
              async limit() {
                return [{ webhookId: 'webhook:test' }];
              },
            };
          },
        };
      },
    };
  }
}

function createRepository(db: FakeDrizzleDb) {
  return new PostgresRuntimeEventRepository(db as never);
}

describe('PostgresRuntimeEventRepository', () => {
  it('commits the runtime event and webhook delivery in one transaction', async () => {
    const db = new FakeDrizzleDb();
    const repository = createRepository(db);

    await expect(
      repository.appendRuntimeEvent({
        appId: 'app:test' as never,
        sessionId: 'session:test' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        actor: 'agent',
        responseMode: 'webhook',
        webhookId: 'webhook:test',
        payload: { text: 'done' },
        createdAt: '2026-04-30T00:00:00.000Z' as never,
      }),
    ).resolves.toMatchObject({
      eventId: 42,
      appId: 'app:test',
      webhookId: 'webhook:test',
      payload: { text: 'done' },
    });

    expect(db.operations).toEqual([
      'transaction:begin',
      'insert:runtime_events',
      'insert:event_bus_outbox',
      'select:webhook',
      'insert:webhook_delivery',
      'transaction:commit',
    ]);
    expect(db.insertedOutboxEvent).toMatchObject({
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      eventVersion: 1,
      source: 'gantry.runtime_events',
      appId: 'app:test',
      runtimeEventId: 42,
      status: 'pending',
      occurredAt: '2026-04-30T00:00:00.000Z',
    });
  });

  it('rolls back the runtime event when outbox enqueue fails', async () => {
    const db = new FakeDrizzleDb();
    db.failOutboxInsert = true;
    const repository = createRepository(db);

    await expect(
      repository.appendRuntimeEvent({
        appId: 'app:test' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        actor: 'agent',
        payload: { text: 'done' },
      }),
    ).rejects.toThrow('outbox insert failed');

    expect(db.operations).toEqual([
      'transaction:begin',
      'insert:runtime_events',
      'insert:event_bus_outbox',
      'transaction:rollback',
    ]);
  });

  it('rolls back the runtime event when webhook delivery enqueue fails', async () => {
    const db = new FakeDrizzleDb();
    db.failDeliveryInsert = true;
    const repository = createRepository(db);

    await expect(
      repository.appendRuntimeEvent({
        appId: 'app:test' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        actor: 'agent',
        responseMode: 'both',
        webhookId: 'webhook:test',
        payload: { text: 'done' },
      }),
    ).rejects.toThrow('delivery insert failed');

    expect(db.operations).toEqual([
      'transaction:begin',
      'insert:runtime_events',
      'insert:event_bus_outbox',
      'select:webhook',
      'insert:webhook_delivery',
      'transaction:rollback',
    ]);
  });

  it('rejects blank runtime event app ids before inserting', async () => {
    const db = new FakeDrizzleDb();
    const repository = createRepository(db);

    await expect(
      repository.appendRuntimeEvent({
        appId: '' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        actor: 'agent',
        payload: { text: 'done' },
      }),
    ).rejects.toThrow('Runtime event appId is required.');

    expect(db.operations).toEqual([
      'transaction:begin',
      'transaction:rollback',
    ]);
  });

  it('rejects unknown runtime event types before inserting', async () => {
    const db = new FakeDrizzleDb();
    const repository = createRepository(db);

    await expect(
      repository.appendRuntimeEvent({
        appId: 'app:test' as never,
        eventType: 'runtime.unknown' as never,
        actor: 'agent',
        payload: { text: 'done' },
      }),
    ).rejects.toThrow('Runtime event type must be a known runtime event type.');

    expect(db.operations).toEqual([
      'transaction:begin',
      'transaction:rollback',
    ]);
  });

  it('normalizes blank optional runtime event ids to null', async () => {
    const db = new FakeDrizzleDb();
    const repository = createRepository(db);

    await repository.appendRuntimeEvent({
      appId: 'app:test' as never,
      agentId: '' as never,
      sessionId: ' ' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'done' },
    });

    expect(db.insertedRuntimeEvent).toEqual(
      expect.objectContaining({
        appId: 'app:test',
        agentId: null,
        sessionId: null,
      }),
    );
    expect(db.operations).toEqual([
      'transaction:begin',
      'insert:runtime_events',
      'insert:event_bus_outbox',
      'transaction:commit',
    ]);
  });

  it('materializes canonical conversation thread rows before appending threaded events', async () => {
    const db = new FakeDrizzleDb();
    const repository = createRepository(db);

    await repository.appendRuntimeEvent({
      appId: 'default' as never,
      conversationId: 'conversation:sl:C0B3M99H1B6' as never,
      threadId: 'thread:sl:C0B3M99H1B6:1784789975.807219' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'done' },
    });

    expect(db.operations).toEqual([
      'transaction:begin',
      'insert:conversation_threads',
      'insert:runtime_events',
      'insert:event_bus_outbox',
      'transaction:commit',
    ]);
    expect(db.insertedConversationThread).toMatchObject({
      id: 'thread:sl:C0B3M99H1B6:1784789975.807219',
      appId: 'default',
      conversationId: 'conversation:sl:C0B3M99H1B6',
    });
    expect(db.insertedConversationThread?.externalRefJson).toBe(
      JSON.stringify({
        kind: 'conversation_thread',
        value: '1784789975.807219',
        jid: 'sl:C0B3M99H1B6',
        threadId: '1784789975.807219',
        externalThreadId: '1784789975.807219',
      }),
    );
    expect(db.insertedRuntimeEvent).toEqual(
      expect.objectContaining({
        conversationId: 'conversation:sl:C0B3M99H1B6',
        threadId: 'thread:sl:C0B3M99H1B6:1784789975.807219',
      }),
    );
  });
});

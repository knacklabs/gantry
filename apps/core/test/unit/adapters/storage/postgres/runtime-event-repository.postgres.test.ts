import { describe, expect, it, vi } from 'vitest';

import { PostgresRuntimeEventRepository } from '@core/adapters/storage/postgres/repositories/runtime-event-repository.postgres.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

class FakeRuntimeEventClient {
  readonly queries: string[] = [];
  failDeliveryInsert = false;
  readonly release = vi.fn();

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO runtime_events')) {
      return {
        rows: [
          {
            eventId: 42,
            appId: params?.[0],
            agentId: null,
            sessionId: params?.[2],
            runId: null,
            jobId: null,
            triggerId: null,
            conversationId: null,
            threadId: null,
            eventType: params?.[8],
            actor: params?.[9],
            correlationId: null,
            responseMode: params?.[11],
            webhookId: params?.[12],
            payloadJson: params?.[13],
            createdAt: params?.[14],
          },
        ],
      };
    }
    if (sql.includes('FROM control_http_webhooks')) {
      return { rows: [{ webhook_id: params?.[0] }] };
    }
    if (sql.includes('INSERT INTO control_http_webhook_deliveries')) {
      if (this.failDeliveryInsert) {
        throw new Error('delivery insert failed');
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

function createRepository(client: FakeRuntimeEventClient) {
  return new PostgresRuntimeEventRepository(
    {} as never,
    {
      connect: vi.fn(async () => client),
    } as never,
  );
}

describe('PostgresRuntimeEventRepository', () => {
  it('commits the runtime event and webhook delivery in one transaction', async () => {
    const client = new FakeRuntimeEventClient();
    const repository = createRepository(client);

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

    expect(client.queries).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO runtime_events'),
      expect.stringContaining('FROM control_http_webhooks'),
      expect.stringContaining('INSERT INTO control_http_webhook_deliveries'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back the runtime event when webhook delivery enqueue fails', async () => {
    const client = new FakeRuntimeEventClient();
    client.failDeliveryInsert = true;
    const repository = createRepository(client);

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

    expect(client.queries).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO runtime_events'),
      expect.stringContaining('FROM control_http_webhooks'),
      expect.stringContaining('INSERT INTO control_http_webhook_deliveries'),
      'ROLLBACK',
    ]);
    expect(client.queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

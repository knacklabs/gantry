import { describe, expect, it, vi } from 'vitest';

import {
  settleEventBusOutboxRows,
  webhookSubscriptionMatchesRuntimeEvent,
} from '@core/adapters/storage/postgres/repositories/event-bus-outbox.postgres.js';

describe('event bus outbox webhook fan-out', () => {
  const event = {
    eventType: 'run.completed',
    agentId: 'agent:one',
    sessionId: 'session:one',
    jobId: 'job:one',
  };

  it('matches event type and every configured subject scope', () => {
    expect(
      webhookSubscriptionMatchesRuntimeEvent(
        {
          eventTypes: ['run.completed'],
          agentId: 'agent:one',
          sessionId: 'session:one',
          jobId: 'job:one',
        },
        event,
      ),
    ).toBe(true);
    expect(
      webhookSubscriptionMatchesRuntimeEvent(
        {
          eventTypes: ['run.failed'],
          agentId: null,
          sessionId: null,
          jobId: null,
        },
        event,
      ),
    ).toBe(false);
    expect(
      webhookSubscriptionMatchesRuntimeEvent(
        {
          eventTypes: ['run.completed'],
          agentId: 'agent:other',
          sessionId: null,
          jobId: null,
        },
        event,
      ),
    ).toBe(false);
  });

  it('does not auto-deliver registrations without event filters', () => {
    expect(
      webhookSubscriptionMatchesRuntimeEvent(
        {
          eventTypes: null,
          agentId: null,
          sessionId: null,
          jobId: null,
        },
        event,
      ),
    ).toBe(false);
  });

  it('settles claimed rows by deleting them after fan-out', async () => {
    const returning = vi.fn(async () => [{ id: 'outbox-1' }]);
    const where = vi.fn(() => ({ returning }));
    const deleteRows = vi.fn(() => ({ where }));
    const executor = { delete: deleteRows };

    await expect(
      settleEventBusOutboxRows(executor as never, ['outbox-1']),
    ).resolves.toBe(1);
    expect(deleteRows).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();

    deleteRows.mockClear();
    await expect(settleEventBusOutboxRows(executor as never, [])).resolves.toBe(
      0,
    );
    expect(deleteRows).not.toHaveBeenCalled();
  });
});

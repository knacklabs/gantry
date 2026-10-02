import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  InboundEventInput,
  InboundEventRepository,
} from '@core/domain/ports/inbound-events.js';
import { PostgresInboundEventRepository } from '@core/adapters/storage/postgres/repositories/inbound-event-repository.postgres.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Missing uniqueness, ordering or edge validation breaks these storage contracts.
// Existing canonical tests cannot observe raw events before decode; no test seam is added.
describe.skipIf(!hasPostgresIntegrationDatabase)(
  'durable inbound event crossing',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let inbox: InboundEventRepository;
    const event = (
      overrides: Partial<InboundEventInput> = {},
    ): InboundEventInput => ({
      appId: 'inbox-app',
      providerId: 'slack',
      connectionId: 'shared-connection',
      kind: 'message',
      eventKey: 'C1:100.1',
      rawChannelId: 'C1',
      rawThreadId: null,
      rawMessageId: '100.1',
      payload: { text: 'hello' },
      control: null,
      ...overrides,
    });
    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'inbox',
      });
      inbox = runtime.repositories.inboundEvents;
    });
    afterAll(async () => {
      await runtime?.cleanup();
    });

    it('saves typed messages and slash events once across shared-account restart', async () => {
      const first = await inbox.save(event());
      expect(first.outcome).toBe('saved');
      if (first.outcome !== 'saved') throw new Error('Expected saved event');
      const restarted = new PostgresInboundEventRepository(runtime.service.db);
      const duplicate = await restarted.save(
        event({ payload: { text: 'redelivery' } }),
      );
      expect(duplicate).toEqual({ outcome: 'duplicate', event: first.event });
      const slash = await inbox.save(
        event({ kind: 'slash', eventKey: 'interaction-1', rawMessageId: null }),
      );
      expect(slash.outcome).toBe('saved');
      if (slash.outcome !== 'saved') throw new Error('Expected saved slash');
      expect(slash.event.seq).toBeGreaterThan(first.event.seq);
      expect(first.event).toMatchObject({
        state: 'pending',
        attempts: 0,
        deadlineAt: null,
        deleted: false,
        payload: { text: 'hello' },
      });
      expect(first.event.receivedAt).toMatch(/^\d{4}-.*Z$/);
      for (const overrides of [
        { appId: 'other-app' },
        { connectionId: 'other-connection' },
        { providerId: 'discord' as const },
      ]) {
        expect((await inbox.save(event(overrides))).outcome).toBe('saved');
      }
    });

    it('allocates unique received positions and deduplicates concurrent saves', async () => {
      const saved = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          inbox.save(
            event({ eventKey: `ordered-${i}`, connectionId: 'ordered' }),
          ),
        ),
      );
      const sequences = saved.map((result) => {
        if (result.outcome !== 'saved') throw new Error('Expected saved event');
        return result.event.seq;
      });
      expect(new Set(sequences).size).toBe(8);
      const duplicate = await Promise.all(
        Array.from({ length: 4 }, () =>
          inbox.save(event({ eventKey: 'concurrent-duplicate' })),
        ),
      );
      expect(
        duplicate.filter((result) => result.outcome === 'saved'),
      ).toHaveLength(1);
      expect(
        new Set(
          duplicate.map((result) =>
            'event' in result ? result.event.id : null,
          ),
        ).size,
      ).toBe(1);
    });

    it('preserves raw held-delete scope without depending on thread or account lookups', async () => {
      const input = event({ eventKey: 'held-delete', rawThreadId: null });
      const result = await inbox.save(input);
      if (result.outcome !== 'saved') throw new Error('Expected saved event');
      expect(await inbox.get(result.event.id, input.appId)).toMatchObject({
        appId: input.appId,
        providerId: 'slack',
        connectionId: 'shared-connection',
        rawChannelId: 'C1',
        rawThreadId: null,
        rawMessageId: '100.1',
      });
      expect(await inbox.get(result.event.id, 'other-app')).toBeNull();
    });

    it('does not save unsupported classifications or malformed incoming contracts', async () => {
      const before = await runtime.service.pool.query(
        'SELECT count(*)::int AS count FROM inbound_events',
      );
      expect(await inbox.save({ outcome: 'unsupported' })).toEqual({
        outcome: 'unsupported',
      });
      for (const input of [
        event({ eventKey: '' }),
        event({ rawChannelId: '' }),
        { ...event(), providerId: 'unknown' },
        { ...event(), providerId: 'app' },
        { ...event(), payload: undefined },
        { ...event(), providerAccountId: 'account' },
      ]) {
        expect(await inbox.save(input)).toEqual({ outcome: 'malformed' });
      }
      const after = await runtime.service.pool.query(
        'SELECT count(*)::int AS count FROM inbound_events',
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  },
);

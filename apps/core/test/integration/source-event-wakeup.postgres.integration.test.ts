import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createClient,
  hashSourceMessage,
} from '../../../../packages/sdk/src/index.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { appendSourceRuntimeEvent } from '@core/adapters/storage/postgres/repositories/source-channel-event-lock.postgres.js';
import { parseRuntimeEventWakeup } from '@core/adapters/storage/postgres/runtime-event-notifier.postgres.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as schema from '@core/adapters/storage/postgres/schema/schema.js';
import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';
import { adaptSessionControlPort } from '@core/control/server/session-control-port.js';
import { handleSessionRoutes } from '@core/control/server/routes/sessions.js';
import { handleRuntimeEventRoutes } from '@core/control/server/routes/runtime-events.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';

const run = hasPostgresIntegrationDatabase ? describe : describe.skip;
run('commit-bound native source event wakeups', () => {
  let runtime: PostgresIntegrationRuntime;
  let listener: PoolClient;
  const notifications: ReturnType<typeof parseRuntimeEventWakeup>[] = [];
  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'source_event_wakeup',
    });
    listener = await runtime.service.pool.connect();
    listener.on('notification', (message) =>
      notifications.push(parseRuntimeEventWakeup(message.payload)),
    );
    await listener.query('LISTEN gantry_runtime_events');
  }, 60000);
  afterAll(async () => {
    if (listener) {
      await listener.query('UNLISTEN gantry_runtime_events');
      listener.release();
    }
    if (runtime) {
      await runtime.storageRuntime.runtimeEventNotifier.close();
      await runtime.cleanup();
    }
  });

  it('notifies only committed real rows and never a rolled-back event', async () => {
    const before = notifications.length;
    let release!: () => void;
    let inserted!: () => void;
    const entered = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = runtime.service.db.transaction(async (tx) => {
      const [event] = await appendSourceRuntimeEvent(tx, {
        appId: 'default',
        eventType: 'interaction.pending',
        actor: 'system',
        correlationId: 'commit-fixture',
        payloadJson: '{}',
      });
      inserted();
      await held;
      return event!;
    });
    await entered;
    await listener.query('SELECT 1');
    expect(notifications).toHaveLength(before);
    release();
    const committed = await transaction;
    await expect
      .poll(() => notifications.length, { timeout: 1000 })
      .toBe(before + 1);
    expect(notifications.at(-1)).toMatchObject({
      eventId: committed.eventId,
      appId: 'default',
      eventType: 'interaction.pending',
      complete: true,
    });
    const rollbackId = randomUUID();
    await expect(
      runtime.service.db.transaction(async (tx) => {
        await appendSourceRuntimeEvent(tx, {
          appId: 'default',
          eventType: 'source.answer.failed',
          actor: 'system',
          correlationId: rollbackId,
          payloadJson: '{}',
        });
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    await listener.query('SELECT 1');
    expect(notifications).toHaveLength(before + 1);
    expect(
      await runtime.service.db
        .select()
        .from(schema.runtimeEventsPostgres)
        .where(eq(schema.runtimeEventsPostgres.correlationId, rollbackId)),
    ).toEqual([]);
  });

  it('wakes the actual SDK HTTP stream promptly for store-only writes and preserves replay', async () => {
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const discussionId = `discussion-${randomUUID()}`;
    const { sessionId } = await runtime.control.ensureAppSession({
      appId: 'default',
      conversationId: discussionId,
      chatJid: `app:default:${discussionId}`,
      workspaceFolder: 'main_agent',
    });
    const make = (position: string) => {
      const message = {
        sourceMessageId: `M${position}`,
        sourcePosition: position,
        authorId: 'person1',
        authorKind: 'human' as const,
        authorDisplayName: 'Fixture',
        text: 'ordinary stored source',
        createdAt: new Date().toISOString(),
        replyToSourceId: null,
        revisionId: 'R1',
        origin: 'human' as const,
      };
      return {
        binding: {
          discussionId,
          generation: 1,
          workspaceId: 'W1',
          tenderId: 'T1',
        },
        authority: {
          authorityId: 'fixture',
          authorityVersion: '1',
          kind: 'service' as const,
          subject: 'fixture',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        message: { ...message, contentHash: hashSourceMessage(message) },
        idempotencyKey: `store-${position}`,
      };
    };
    await runtime.control.appendSourceMessage('default', sessionId, make('1'));
    const token = randomUUID();
    const module = new SessionInteractionModule({
      control: adaptSessionControlPort(runtime.control),
      ops: {} as never,
      repositories: {} as never,
      runtimeEvents: {} as never,
      now: () => new Date().toISOString() as never,
      createId: randomUUID,
      stableHash: (v) => createHash('sha256').update(v).digest('hex'),
    });
    const ctx = {
      keys: [
        {
          kid: 'fixture',
          tokenHash: createHash('sha256').update(token).digest(),
          scopes: new Set(['sessions:read', 'sessions:write', 'jobs:read']),
          appId: 'default',
        },
      ],
      sessionInteraction: module,
      state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
      maxConcurrentStreams: 10,
    } as ControlRouteContext;
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      void (async () => {
        if (await handleRuntimeEventRoutes(req, res, ctx, url, url.pathname))
          return;
        if (await handleSessionRoutes(req, res, ctx, url, url.pathname)) return;
        res.writeHead(404).end();
      })().catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const abort = new AbortController();
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('Missing fixture port');
      const sdk = createClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: token,
      });
      const stream = sdk.runtimeEvents
        .stream({ sessionId, signal: abort.signal })
        [Symbol.asyncIterator]();
      const initial = await stream.next();
      expect(initial.value?.eventType).toBe('source.message.stored');
      const pending = stream.next();
      const input = make('2');
      const started = performance.now();
      const receipt = await sdk.sessions.appendSourceMessage(sessionId, input);
      const next = await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Error('Source stream did not wake promptly')),
            1500,
          ),
        ),
      ]);
      expect(next.value?.eventId).toBe(Number(receipt.persistedEventId));
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(1500);
      console.info(
        JSON.stringify({
          fixture: 'source-event-SDK-HTTP',
          sourceStoreToStreamMs: elapsedMs,
          modelCalls: 0,
        }),
      );
      expect(await sdk.sessions.appendSourceMessage(sessionId, input)).toEqual({
        ...receipt,
        replayed: true,
      });
      expect(
        await runtime.repositories.runtimeEvents.listRuntimeEvents({
          appId: 'default' as never,
          sessionId: sessionId as never,
          eventTypes: ['source.message.stored'],
          limit: 10,
        }),
      ).toHaveLength(2);
      expect(
        await runtime.service.db
          .select()
          .from(schema.pendingInteractionsPostgres),
      ).toHaveLength(0);
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { PostgresStorageService } from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresCanonicalMessageRepository } from '../../../src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';
import * as schema from '../../../src/adapters/storage/postgres/schema/schema.js';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';
import type { AppendSourceMessageRequest } from '@gantry/contracts';

const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('durable native source channel', () => {
  let service: PostgresStorageService;
  let control: PostgresControlPlaneRepository;
  let sessionId: string;
  const appId = `source-test-${randomUUID()}`;
  const make = (
    sourcePosition: string,
    sourceMessageId = `M${sourcePosition}`,
    text = 'hello',
  ): AppendSourceMessageRequest => {
    const message = {
      sourceMessageId,
      sourcePosition,
      authorId: 'person1',
      authorKind: 'human' as const,
      authorDisplayName: 'Alice',
      text,
      createdAt: '2026-11-17T00:00:00.000Z',
      replyToSourceId: null,
      revisionId: 'R1',
      origin: 'human' as const,
    };
    return {
      binding: {
        discussionId: 'D1',
        generation: 1,
        workspaceId: 'W1',
        tenderId: 'T1',
      },
      authority: {
        authorityId: 'service1',
        authorityVersion: '1',
        kind: 'service',
        subject: 'app1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      message: { ...message, contentHash: hashSourceMessage(message) },
      idempotencyKey: `delivery:${sourceMessageId}`,
    };
  };
  beforeAll(async () => {
    service = new PostgresStorageService(
      process.env.GANTRY_DATABASE_URL!,
      'gantry',
    );
    await service.migrate();
    control = new PostgresControlPlaneRepository(service.db);
    const session = await control.ensureAppSession({
      appId,
      conversationId: 'D1',
      chatJid: `app:${appId}:D1`,
      workspaceFolder: 'native-chat-test',
    });
    sessionId = session.sessionId;
  }, 60000);
  afterAll(async () => {
    if (service) {
      await service.db
        .delete(schema.appsPostgres)
        .where(eq(schema.appsPostgres.id, appId));
      await service.close();
    }
  });
  it('stores canonical history without admitting native work on polls or replay', async () => {
    const stored = await control.appendSourceMessage(
      appId,
      sessionId,
      make('2'),
    );
    expect(stored.contiguousPosition).toBe('0');
    const messageRepo = new PostgresCanonicalMessageRepository(service.db);
    expect(
      await messageRepo.listInboundMessages({ jids: [`app:${appId}:D1`] }),
    ).toEqual([]);
    expect(
      await messageRepo.listContextMessages({ jids: [`app:${appId}:D1`] }),
    ).toHaveLength(1);
    const admissions = await service.db.execute(
      sql`SELECT count(*)::int AS n FROM live_admission_work_items WHERE app_id=${appId}`,
    );
    expect(admissions.rows[0]).toMatchObject({ n: 0 });
    const one = await control.appendSourceMessage(appId, sessionId, make('1'));
    expect(one.contiguousPosition).toBe('2');
    expect(
      await control.appendSourceMessage(appId, sessionId, make('2')),
    ).toEqual({ ...stored, replayed: true, contiguousPosition: '2' });
  });
  it('rejects conflicting payloads and unrelated discussion bindings', async () => {
    await expect(
      control.appendSourceMessage(appId, sessionId, make('2', 'M2', 'changed')),
    ).rejects.toThrow(/conflict/i);
    const wrong = make('3');
    wrong.binding.workspaceId = 'W2';
    await expect(
      control.appendSourceMessage(appId, sessionId, wrong),
    ).rejects.toThrow(/binding/i);
  });
  it('serializes concurrent deliveries and retains a single receipt across repository restart', async () => {
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () =>
        control.appendSourceMessage(appId, sessionId, make('3')),
      ),
    );
    expect(new Set(receipts.map((row) => row.messageId)).size).toBe(1);
    expect(receipts.filter((row) => !row.replayed)).toHaveLength(1);
    const restart = new PostgresControlPlaneRepository(service.db);
    expect(
      (await restart.appendSourceMessage(appId, sessionId, make('3')))
        .persistedEventId,
    ).toBe(receipts[0]!.persistedEventId);
  });
});

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PostgresStorageService } from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import * as s from '../../../src/adapters/storage/postgres/schema/schema.js';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';
const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('source binding survives ordinary SDK session ensure', () => {
  it('preserves binding/checkpoint across ensure and hydrates a historically erased binding on immutable replay', async () => {
    const db = new PostgresStorageService(
      process.env.GANTRY_DATABASE_URL!,
      'gantry',
    );
    const appId = `binding-${randomUUID()}`;
    const repo = new PostgresControlPlaneRepository(db.db);
    try {
      await db.migrate();
      const input = {
        appId,
        conversationId: 'D1',
        chatJid: `app:${appId}:D1`,
        workspaceFolder: `binding-${randomUUID()}`,
      };
      const session = await repo.ensureAppSession(input);
      const message = {
        sourceMessageId: 'M1',
        sourcePosition: '1',
        authorId: 'person1',
        authorKind: 'human' as const,
        authorDisplayName: 'Alice',
        text: 'hello',
        createdAt: '2026-11-17T00:00:00.000Z',
        replyToSourceId: null,
        revisionId: 'R1',
        origin: 'human' as const,
      };
      const body = {
        binding: {
          discussionId: 'D1',
          generation: 1,
          workspaceId: 'W1',
          tenderId: 'T1',
        },
        authority: {
          authorityId: 'service1',
          authorityVersion: '1',
          kind: 'service' as const,
          subject: 'service1',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
        message: { ...message, contentHash: hashSourceMessage(message) },
        idempotencyKey: 'delivery-M1',
      };
      await repo.appendSourceMessage(appId, session.sessionId, body);
      await repo.ensureAppSession(input);
      const [row] = await db.db
        .select()
        .from(s.controlHttpSessionsPostgres)
        .where(eq(s.controlHttpSessionsPostgres.sessionId, session.sessionId));
      expect(row?.externalRefJson).toMatchObject({
        sourceBinding: body.binding,
        sourceContiguousPosition: '1',
      });
      const answer = {
        binding: body.binding,
        authority: {
          authorityId: 'people',
          authorityVersion: '1',
          kind: 'person' as const,
          subject: 'person1',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
        questionSourceId: 'M1',
        sourceCutoff: '1',
        requesterId: 'person1',
        answerGoalId: 'goal',
        attemptId: 'attempt',
        idempotencyKey: 'attempt',
        revisionId: 'R1',
        analysisReady: true as const,
        model: 'haiku',
        maxOutputTokens: 2000,
        deadlineAt: '2027-01-01T00:00:00.000Z',
      };
      expect(
        await repo.requestSourceAnswer(appId, session.sessionId, answer),
      ).toMatchObject({ state: 'preparing' });
      const second = {
        ...message,
        sourceMessageId: 'M2',
        sourcePosition: '2',
        text: 'second',
      };
      await Promise.all([
        repo.ensureAppSession(input),
        repo.appendSourceMessage(appId, session.sessionId, {
          ...body,
          message: { ...second, contentHash: hashSourceMessage(second) },
          idempotencyKey: 'delivery-M2',
        }),
      ]);
      await db.db
        .update(s.controlHttpSessionsPostgres)
        .set({
          externalRefJson: {
            externalConversationId: 'D1',
            chatJid: input.chatJid,
            workspaceFolder: input.workspaceFolder,
          },
        })
        .where(eq(s.controlHttpSessionsPostgres.sessionId, session.sessionId));
      expect(
        await repo.appendSourceMessage(appId, session.sessionId, body),
      ).toMatchObject({ replayed: true, contiguousPosition: '2' });
      const [repaired] = await db.db
        .select()
        .from(s.controlHttpSessionsPostgres)
        .where(eq(s.controlHttpSessionsPostgres.sessionId, session.sessionId));
      expect(repaired?.externalRefJson).toMatchObject({
        sourceBinding: body.binding,
        sourceContiguousPosition: '2',
        sourceAuthority: { authorityId: 'service1', subject: 'service1' },
      });
      expect(
        await repo.requestSourceAnswer(appId, session.sessionId, answer),
      ).toMatchObject({ replayed: true });
    } finally {
      await db.db.delete(s.appsPostgres).where(eq(s.appsPostgres.id, appId));
      await db.close();
    }
  }, 60000);
});

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresSourceAnswerRepository } from '../../../src/adapters/storage/postgres/repositories/source-answer-repository.postgres.js';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';
import * as s from '../../../src/adapters/storage/postgres/schema/schema.js';
const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('expired queued source admission', () => {
  it('publishes a correlated terminal before source provider preparation without extending the immutable deadline', async () => {
    const schema = 'expired_admission_' + randomUUID().replaceAll('-', '');
    const db = new PostgresStorageService(
      process.env.GANTRY_DATABASE_URL!,
      schema,
    );
    const appId = `expiry-${randomUUID()}`;
    const control = new PostgresControlPlaneRepository(db.db);
    const now = Date.now();
    try {
      await db.migrate();
      const session = await control.ensureAppSession({
        appId,
        conversationId: 'D1',
        chatJid: `app:${appId}:D1`,
        workspaceFolder: `expiry-${randomUUID()}`,
      });
      const binding = {
        discussionId: 'D1',
        generation: 1,
        workspaceId: 'W1',
        tenderId: 'T1',
      };
      const message = {
        sourceMessageId: 'M1',
        sourcePosition: '1',
        authorId: 'p1',
        authorKind: 'human' as const,
        authorDisplayName: 'Person',
        text: 'Question',
        createdAt: new Date(now).toISOString(),
        replyToSourceId: null,
        revisionId: 'R1',
        origin: 'human' as const,
      };
      await control.appendSourceMessage(appId, session.sessionId, {
        binding,
        authority: {
          authorityId: 'service',
          authorityVersion: '1',
          kind: 'service',
          subject: 'service',
          expiresAt: new Date(now + 600000).toISOString(),
        },
        message: { ...message, contentHash: hashSourceMessage(message) },
        idempotencyKey: 'source1',
      });
      const request = {
        binding,
        authority: {
          authorityId: 'person',
          authorityVersion: '1',
          kind: 'person' as const,
          subject: 'p1',
          expiresAt: new Date(now + 600000).toISOString(),
        },
        questionSourceId: 'M1',
        sourceCutoff: '1',
        requesterId: 'p1',
        answerGoalId: 'expired-goal',
        attemptId: 'expired-attempt',
        idempotencyKey: 'expired-attempt',
        revisionId: 'R1',
        analysisReady: true as const,
        model: 'haiku',
        maxOutputTokens: 2000,
        deadlineAt: new Date(now + 30000).toISOString(),
      };
      await control.requestSourceAnswer(appId, session.sessionId, request);
      await control.settleExecutionAuthority(appId, session.sessionId, {
        binding,
        interactionId: `authority:source-answer:${appId}:expired-attempt`,
        idempotencyKey: 'authority1',
        answerGoalId: 'expired-goal',
        attemptId: 'expired-attempt',
        allowed: true,
        authorityVersion: '1',
        expiresAt: new Date(now + 600000).toISOString(),
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now + 30001);
      expect(
        await new PostgresSourceAnswerRepository(db.db).prepared(
          appId,
          `app:${appId}:D1`,
        ),
      ).toBeUndefined();
      const [answer] = await db.db
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(
          eq(
            s.pendingInteractionsPostgres.id,
            `source-answer:${appId}:expired-attempt`,
          ),
        );
      expect(answer?.status).toBe('cancelled');
      expect((answer?.payloadJson as any).request.deadlineAt).toBe(
        request.deadlineAt,
      );
      expect(answer?.runId).toBeNull();
      const events = await db.db
        .select()
        .from(s.runtimeEventsPostgres)
        .where(eq(s.runtimeEventsPostgres.appId, appId));
      expect(
        events.some(
          (event) =>
            event.eventType === 'source.answer.failed' &&
            event.correlationId === 'expired-goal',
        ),
      ).toBe(true);
      expect(
        await db.db
          .select()
          .from(s.agentRunsPostgres)
          .where(eq(s.agentRunsPostgres.appId, appId)),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await db.pool.query(
        `drop schema ${quotePostgresIdentifier(schema)} cascade`,
      );
      await db.close();
    }
  }, 60000);
});

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PostgresStorageService } from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresSourceAnswerRepository } from '../../../src/adapters/storage/postgres/repositories/source-answer-repository.postgres.js';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';
import * as s from '../../../src/adapters/storage/postgres/schema/schema.js';
const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('fresh authority for an owned prepared source answer', () => {
  it.each(['allowed', 'denied', 'expired', 'stale-owner'] as const)(
    'handles %s without preparing or dispatching another answer',
    async (decision) => {
      const service = new PostgresStorageService(
        process.env.GANTRY_DATABASE_URL!,
        'gantry',
      );
      const appId = `provider-authority-${randomUUID()}`;
      try {
        await service.migrate();
        const control = new PostgresControlPlaneRepository(service.db);
        const native = new PostgresSourceAnswerRepository(service.db);
        const session = await control.ensureAppSession({
          appId,
          conversationId: 'D1',
          chatJid: `app:${appId}:D1`,
          workspaceFolder: appId,
        });
        const binding = {
          discussionId: 'D1',
          generation: 1,
          workspaceId: 'W1',
          tenderId: 'T1',
        };
        const expiresAt = new Date(Date.now() + 120000).toISOString();
        const authority = {
          authorityId: 'person',
          authorityVersion: '1',
          kind: 'person' as const,
          subject: 'p1',
          expiresAt,
        };
        const message = {
          sourceMessageId: 'M1',
          sourcePosition: '1',
          authorId: 'p1',
          authorKind: 'human' as const,
          authorDisplayName: 'Person',
          text: 'Exact question',
          createdAt: new Date().toISOString(),
          replyToSourceId: null,
          revisionId: 'R1',
          origin: 'human' as const,
        };
        await control.appendSourceMessage(appId, session.sessionId, {
          binding,
          authority: { ...authority, kind: 'service' },
          message: { ...message, contentHash: hashSourceMessage(message) },
          idempotencyKey: 'M1',
        });
        const request = {
          binding,
          authority,
          questionSourceId: 'M1',
          sourceCutoff: '1',
          requesterId: 'p1',
          answerGoalId: 'goal',
          attemptId: 'attempt',
          idempotencyKey: 'attempt',
          revisionId: 'R1',
          analysisReady: true as const,
          model: 'haiku',
          maxOutputTokens: 2000,
          deadlineAt: expiresAt,
        };
        await native.request(appId, session.sessionId, request);
        const id = `source-answer:${appId}:attempt`;
        await control.settleExecutionAuthority(appId, session.sessionId, {
          binding,
          interactionId: `authority:${id}`,
          idempotencyKey: 'admission',
          answerGoalId: 'goal',
          attemptId: 'attempt',
          allowed: true,
          authorityVersion: '1',
          expiresAt,
        });
        expect(await native.prepared(appId, `app:${appId}:D1`)).toBeUndefined();
        const pending = await service.db
          .select()
          .from(s.pendingInteractionsPostgres)
          .where(eq(s.pendingInteractionsPostgres.appId, appId));
        const execution = pending.find(
          (row) => (row.payloadJson as any).request?.phase === 'execution',
        )!;
        await control.settleExecutionAuthority(appId, session.sessionId, {
          binding,
          interactionId: execution.id,
          idempotencyKey: 'initial-execution',
          answerGoalId: 'goal',
          attemptId: 'attempt',
          allowed: true,
          authorityVersion: '1',
          expiresAt: new Date(Date.now() + 5000).toISOString(),
        });
        const prepared = await native.prepared(appId, `app:${appId}:D1`);
        expect(prepared).toBeDefined();
        const before = (
          await service.db
            .select()
            .from(s.pendingInteractionsPostgres)
            .where(eq(s.pendingInteractionsPostgres.id, id))
        )[0]!;
        const promise = native.authorizePrepared(
          id,
          decision === 'stale-owner' ? 'wrong-owner' : prepared!.claimToken,
          Date.now() + 10000,
        );
        const settled = promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        if (decision === 'stale-owner') {
          expect((await settled).error?.message).toMatch(/ownership/);
          return;
        }
        let interaction:
          | typeof s.pendingInteractionsPostgres.$inferSelect
          | undefined;
        await vi.waitFor(async () => {
          const rows = await service.db
            .select()
            .from(s.pendingInteractionsPostgres)
            .where(
              and(
                eq(s.pendingInteractionsPostgres.appId, appId),
                eq(s.pendingInteractionsPostgres.status, 'pending'),
              ),
            );
          interaction = rows.find(
            (row) =>
              row.id !== execution.id &&
              (row.payloadJson as any).request?.phase === 'execution',
          );
          expect(interaction).toBeDefined();
        });
        const freshExpiry = new Date(
          Date.now() + (decision === 'expired' ? -1 : 5000),
        ).toISOString();
        await control.settleExecutionAuthority(appId, session.sessionId, {
          binding,
          interactionId: interaction!.id,
          idempotencyKey: 'fresh-execution',
          answerGoalId: 'goal',
          attemptId: 'attempt',
          allowed: decision !== 'denied',
          authorityVersion: '1',
          expiresAt: freshExpiry,
        });
        const result = await settled;
        if (decision === 'allowed') {
          expect(result.error).toBeUndefined();
          expect(result.value).toBe(Date.parse(freshExpiry));
          const after = (
            await service.db
              .select()
              .from(s.pendingInteractionsPostgres)
              .where(eq(s.pendingInteractionsPostgres.id, id))
          )[0]!;
          expect(after.runLeaseToken).toBe(prepared!.claimToken);
          expect((after.payloadJson as any).contextSnapshot).toEqual(
            (before.payloadJson as any).contextSnapshot,
          );
          expect((after.payloadJson as any).request).toEqual(request);
          expect(after.runId).toBe(before.runId);
        } else
          expect(result.error?.message).toMatch(/denied|expired|ownership/);
      } finally {
        await service.db
          .delete(s.appsPostgres)
          .where(eq(s.appsPostgres.id, appId));
        await service.close();
      }
    },
    60000,
  );
});

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createClient } from '../../../../../packages/sdk/src/index.js';
import { handleSessionRoutes } from '../../../src/control/server/routes/sessions.js';
import { SessionInteractionModule } from '../../../src/application/sessions/session-interaction-module.js';
import { adaptSessionControlPort } from '../../../src/control/server/session-control-port.js';
import type { ControlRouteContext } from '../../../src/control/server/handler-context.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { PostgresStorageService } from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresCanonicalMessageRepository } from '../../../src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';
import * as schema from '../../../src/adapters/storage/postgres/schema/schema.js';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';
import { PostgresSourceAnswerRepository } from '../../../src/adapters/storage/postgres/repositories/source-answer-repository.postgres.js';
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
      replyToSourceId: sourceMessageId === 'M2' ? 'M1' : null,
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
  it('accepts an explicit stored question and waits durably for current authority without another message', async () => {
    const input = {
      binding: make('2').binding,
      authority: {
        authorityId: 'people',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: 'person1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      questionSourceId: 'M2',
      sourceCutoff: '2',
      requesterId: 'person1',
      answerGoalId: 'goal1',
      attemptId: 'attempt1',
      idempotencyKey: 'answer1',
      revisionId: 'R1',
      analysisReady: true as const,
      model: 'haiku',
      maxOutputTokens: 2000,
      deadlineAt: '2027-01-01T00:00:00.000Z',
    };
    const accepted = await control.requestSourceAnswer(appId, sessionId, input);
    expect(accepted.state).toBe('preparing');
    expect(
      (await control.requestSourceAnswer(appId, sessionId, input)).replayed,
    ).toBe(true);
    const rows = await service.db
      .select()
      .from(schema.messagesPostgres)
      .where(eq(schema.messagesPostgres.appId, appId));
    expect(rows).toHaveLength(2);
    await expect(
      control.requestSourceAnswer(appId, sessionId, {
        ...input,
        sourceCutoff: '1',
      }),
    ).rejects.toThrow(/conflict/);
    const pending = await service.db
      .select()
      .from(schema.pendingInteractionsPostgres)
      .where(eq(schema.pendingInteractionsPostgres.appId, appId));
    expect(
      pending.some(
        (row) =>
          (row.payloadJson as any).request?.interactionType ===
          'execution_authority',
      ),
    ).toBe(true);
    const authority = pending.find(
      (row) =>
        (row.payloadJson as any).request?.interactionType ===
        'execution_authority',
    )!;
    const settlement = {
      interactionId: authority.id,
      idempotencyKey: 'authority-reply',
      binding: input.binding,
      answerGoalId: 'goal1',
      attemptId: 'attempt1',
      allowed: true,
      authorityVersion: '1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    expect(
      await control.settleExecutionAuthority(appId, sessionId, settlement),
    ).toMatchObject({ accepted: true, replayed: false });
    expect(
      await control.settleExecutionAuthority(appId, sessionId, settlement),
    ).toMatchObject({ replayed: true });
    const native = new PostgresSourceAnswerRepository(service.db);
    const prepared = await native.prepared(appId, `app:${appId}:D1`);
    expect(prepared?.selectedSourceIds).toEqual(['M1', 'M2']);
    expect(prepared?.request.model).toBe('haiku');
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
  it('crosses the actual SDK HTTP receiver and returns a durable replayable receipt', async () => {
    const token = randomUUID();
    const module = new SessionInteractionModule({
      control: adaptSessionControlPort(control),
      ops: {} as never,
      repositories: {} as never,
      runtimeEvents: {} as never,
      now: () => new Date().toISOString() as never,
      createId: randomUUID,
      stableHash: (value) => createHash('sha256').update(value).digest('hex'),
    });
    const ctx = {
      keys: [
        {
          kid: 'test',
          tokenHash: createHash('sha256').update(token).digest(),
          scopes: new Set(['sessions:write', 'agents:admin']),
          appId,
        },
      ],
      sessionInteraction: module,
    } as ControlRouteContext;
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      void handleSessionRoutes(req, res, ctx, url, url.pathname)
        .then((handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        })
        .catch(() => {
          res.statusCode = 500;
          res.end('unexpected test server failure');
        });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string')
        throw new Error('HTTP fixture not listening');
      const sdk = createClient({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        apiKey: token,
      });
      const first = await sdk.sessions.appendSourceMessage(
        sessionId,
        make('4'),
      );
      expect(first.stored).toBe(true);
      expect(
        await sdk.sessions.appendSourceMessage(sessionId, make('4')),
      ).toEqual({ ...first, replayed: true });
      await expect(
        sdk.sessions.appendSourceMessage(sessionId, {
          ...make('5'),
          lastReadPosition: '2',
        } as any),
      ).rejects.toThrow(/Unsupported session request field/);
      const rows = await service.db
        .select()
        .from(schema.messagesPostgres)
        .where(
          and(
            eq(schema.messagesPostgres.appId, appId),
            eq(schema.messagesPostgres.sourceMessageId, 'M4'),
          ),
        );
      expect(rows).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

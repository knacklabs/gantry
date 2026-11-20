import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';
import { PostgresStorageService } from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresSourceAnswerRepository } from '../../../src/adapters/storage/postgres/repositories/source-answer-repository.postgres.js';
import {
  configureCustomModelCatalogEntries,
  resolveModelSelectionForWorkload,
} from '../../../src/shared/model-catalog.js';
import * as s from '../../../src/adapters/storage/postgres/schema/schema.js';
const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('private model admission snapshot persistence', () => {
  const appId = `model-pin-${randomUUID()}`;
  let db: PostgresStorageService;
  let control: PostgresControlPlaneRepository;
  beforeAll(async () => {
    db = new PostgresStorageService(process.env.GANTRY_DATABASE_URL!, 'gantry');
    await db.migrate();
    control = new PostgresControlPlaneRepository(db.db);
  }, 60000);
  afterAll(async () => {
    configureCustomModelCatalogEntries([]);
    if (db) {
      await db.db.delete(s.appsPostgres).where(eq(s.appsPostgres.id, appId));
      await db.close();
    }
  });
  it('persists the admitted route across repository restart and alias replacement/removal, then fails legacy dispatch clearly', async () => {
    const before = resolveModelSelectionForWorkload('haiku', 'chat');
    const after = fixtureEntry('gpt-5.5');
    if (!before.ok) throw new Error('Fixture absent');
    const alias = 'model-pin-pg';
    configureCustomModelCatalogEntries([
      {
        ...before.entry,
        id: 'pin-pg-before',
        aliases: [alias],
        recommendedAlias: alias,
      },
    ]);
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
    const message = {
      sourceMessageId: 'M1',
      sourcePosition: '1',
      authorId: 'person1',
      authorKind: 'human' as const,
      authorDisplayName: 'Person',
      text: 'What did we discuss?',
      createdAt: new Date().toISOString(),
      replyToSourceId: null,
      revisionId: 'R1',
      origin: 'human' as const,
    };
    const expiresAt = new Date(Date.now() + 120000).toISOString();
    await control.appendSourceMessage(appId, session.sessionId, {
      binding,
      authority: {
        authorityId: 'service',
        authorityVersion: '1',
        kind: 'service',
        subject: 'service',
        expiresAt,
      },
      message: { ...message, contentHash: hashSourceMessage(message) },
      idempotencyKey: 'delivery',
    });
    const request = {
      binding,
      authority: {
        authorityId: 'person',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: 'person1',
        expiresAt,
      },
      questionSourceId: 'M1',
      sourceCutoff: '1',
      requesterId: 'person1',
      answerGoalId: randomUUID(),
      attemptId: randomUUID(),
      idempotencyKey: randomUUID(),
      revisionId: 'R1',
      analysisReady: true as const,
      model: alias,
      maxOutputTokens: 2000,
      deadlineAt: expiresAt,
    };
    const native = new PostgresSourceAnswerRepository(db.db);
    const receipt = await native.request(appId, session.sessionId, request);
    const id = `source-answer:${appId}:${request.attemptId}`;
    const read = async () =>
      (
        await db.db
          .select()
          .from(s.pendingInteractionsPostgres)
          .where(eq(s.pendingInteractionsPostgres.id, id))
      )[0]!;
    expect((await read()).payloadJson).toMatchObject({
      request: { model: alias },
      modelSnapshot: {
        version: 1,
        alias,
        entry: {
          runnerModel: before.entry.runnerModel,
          modelRoute: { id: 'anthropic' },
        },
      },
    });
    configureCustomModelCatalogEntries([
      {
        ...after,
        id: 'pin-pg-after',
        aliases: [alias],
        recommendedAlias: alias,
      },
    ]);
    const restarted = new PostgresSourceAnswerRepository(db.db);
    expect(
      await restarted.request(appId, session.sessionId, request),
    ).toMatchObject({ ...receipt, replayed: true });
    const freshRequest = {
      ...request,
      answerGoalId: randomUUID(),
      attemptId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    await restarted.request(appId, session.sessionId, freshRequest);
    const [fresh] = await db.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(
        eq(
          s.pendingInteractionsPostgres.id,
          `source-answer:${appId}:${freshRequest.attemptId}`,
        ),
      );
    expect(fresh!.payloadJson).toMatchObject({
      modelSnapshot: {
        entry: { runnerModel: after.runnerModel, modelRoute: { id: 'openai' } },
      },
    });
    configureCustomModelCatalogEntries([]);
    expect(
      await restarted.request(appId, session.sessionId, request),
    ).toMatchObject({ ...receipt, replayed: true });
    expect((await read()).payloadJson).toMatchObject({
      modelSnapshot: {
        entry: {
          runnerModel: before.entry.runnerModel,
          modelRoute: { id: 'anthropic' },
        },
      },
    });
    const legacy = structuredClone((await read()).payloadJson) as Record<
      string,
      unknown
    >;
    delete legacy.modelSnapshot;
    legacy.state = 'queued';
    await db.db
      .update(s.pendingInteractionsPostgres)
      .set({ payloadJson: legacy })
      .where(eq(s.pendingInteractionsPostgres.id, id));
    expect(await restarted.dispatchRoute(appId, `app:${appId}:D1`)).toEqual({
      source: true,
    });
    expect((await read()).payloadJson).toMatchObject({
      state: 'failed',
      error: 'Source answer model snapshot unavailable; start a new attempt',
    });
  });
});
function fixtureEntry(alias: string) {
  const value = resolveModelSelectionForWorkload(alias, 'chat');
  if (!value.ok) throw new Error('Fixture absent');
  return value.entry;
}

import { PostgresAgentRepository } from '../../../src/adapters/storage/postgres/repositories/agent-repository.postgres.js';
import { AppMemoryService } from '../../../src/memory/app-memory-service.js';
import { sourceChannelMemorySubject } from '../../../src/memory/source-channel-memory-scope.js';
import { sourceAnswerOutputId } from '../../../src/adapters/storage/postgres/repositories/source-answer-output-id.js';
import { appendSourceAnswerTerminal } from '../../../src/adapters/storage/postgres/repositories/source-answer-terminal.postgres.js';
import { PostgresCanonicalSessionRepository } from '../../../src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';
import { PostgresRuntimeEventRepository } from '../../../src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.js';
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
  const prepareWithFreshAuthority = async (
    native: PostgresSourceAnswerRepository,
    jid: string,
    sid = sessionId,
  ) => {
    const first = await native.prepared(appId, jid);
    if (first) return first;
    const pending = await service.db
      .select()
      .from(schema.pendingInteractionsPostgres)
      .where(
        and(
          eq(schema.pendingInteractionsPostgres.appId, appId),
          eq(schema.pendingInteractionsPostgres.status, 'pending'),
        ),
      );
    const interaction = pending.find(
      (row) => (row.payloadJson as any).request?.phase === 'execution',
    );
    if (!interaction) return;
    const request = (interaction.payloadJson as any).request;
    await control.settleExecutionAuthority(appId, sid, {
      interactionId: interaction.id,
      idempotencyKey: `settle:${interaction.id}`,
      binding: request.binding,
      answerGoalId: request.answerGoalId,
      attemptId: request.attemptId,
      allowed: true,
      authorityVersion: '1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    return native.prepared(appId, jid);
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
    const prepared = await prepareWithFreshAuthority(native, `app:${appId}:D1`);
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
  it('reuses the native SDK session, links output position five once and excludes unrelated ancestors at question six', async () => {
    const session = (await control.getAppSessionById(sessionId))!;
    const canonical = new PostgresCanonicalSessionRepository(service.db);
    const turn = await canonical.getAgentTurnContext({
      appId,
      workspaceFolder: 'native-chat-test',
      executionProviderId: 'anthropic:claude-agent-sdk',
      chatJid: `app:${appId}:D1`,
      providerAccountId: `control:${appId}`,
      scopeKey: 'test-source-context',
      conversationKind: 'channel',
      memoryUserId: 'person1',
    });
    expect(turn.agentSessionId).toBe(sessionId);
    const [agent] = await service.db
      .select()
      .from(schema.agentsPostgres)
      .where(eq(schema.agentsPostgres.id, session.agentId));
    const [config] = await service.db
      .select()
      .from(schema.agentConfigVersionsPostgres)
      .where(
        eq(
          schema.agentConfigVersionsPostgres.id,
          agent!.currentConfigVersionId!,
        ),
      );
    const runId = `run-${randomUUID()}`;
    await service.db.insert(schema.agentRunsPostgres).values({
      id: runId,
      appId,
      agentId: session.agentId,
      configVersionId: config!.id,
      sessionId,
      conversationId: session.canonicalConversationId,
      llmProfileId: config!.llmProfileId,
      executionProviderId: 'anthropic:claude-agent-sdk',
      cause: 'message',
      status: 'running',
      createdAt: new Date().toISOString(),
    });
    const native = new PostgresSourceAnswerRepository(service.db);
    const answerId = `source-answer:${appId}:attempt1`;
    await native.markRun(answerId, runId);
    const output = JSON.stringify({
      version: 1,
      answer: 'Complete',
      answerUnits: [
        {
          text: 'Complete',
          source: 'unconfirmed',
          citationIds: [],
          metadataFields: [],
        },
      ],
    });
    expect(
      await new PostgresSourceAnswerRepository(service.db).recoverRun(runId),
    ).toBe('failed');
    await native.output(answerId, runId, output);
    // Simulate process exit after group cleanup but before fenced terminal commit.
    await native.finishPrepared(answerId, true);
    expect(
      await new PostgresSourceAnswerRepository(service.db).recoverRun(runId),
    ).toBe('completed');
    await service.db.transaction(async (tx) => {
      await tx
        .update(schema.agentRunsPostgres)
        .set({ status: 'completed' })
        .where(eq(schema.agentRunsPostgres.id, runId));
      await appendSourceAnswerTerminal(
        tx,
        runId,
        'completed',
        new Date().toISOString(),
      );
    });
    const row = make('5');
    row.message = {
      ...row.message,
      authorKind: 'assistant',
      authorId: 'agent',
      authorDisplayName: 'Agent',
      origin: 'runtime_output',
      runtimeOutputId: sourceAnswerOutputId(appId, 'goal1', 'attempt1'),
      answerGoalId: 'goal1',
      text: 'Complete',
    };
    row.message.contentHash = hashSourceMessage(row.message);
    const linked = await control.appendSourceMessage(appId, sessionId, row);
    expect(linked.contiguousPosition).toBe('5');
    expect(await control.appendSourceMessage(appId, sessionId, row)).toEqual({
      ...linked,
      replayed: true,
    });
    const outbound = await service.db
      .select()
      .from(schema.messagesPostgres)
      .where(
        and(
          eq(schema.messagesPostgres.appId, appId),
          eq(schema.messagesPostgres.direction, 'outbound'),
        ),
      );
    expect(outbound).toHaveLength(1);
    const six = make('6');
    six.message.replyToSourceId = 'M2';
    six.message.contentHash = hashSourceMessage(six.message);
    await control.appendSourceMessage(appId, sessionId, six);
    const request = {
      binding: six.binding,
      authority: {
        authorityId: 'people',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: 'person1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      questionSourceId: 'M6',
      sourceCutoff: '6',
      requesterId: 'person1',
      answerGoalId: 'goal2',
      attemptId: 'attempt2',
      idempotencyKey: 'answer2',
      revisionId: 'R1',
      analysisReady: true as const,
      model: 'haiku',
      maxOutputTokens: 2000,
      deadlineAt: '2027-01-01T00:00:00.000Z',
    };
    await control.requestSourceAnswer(appId, sessionId, request);
    await control.settleExecutionAuthority(appId, sessionId, {
      interactionId: `authority:source-answer:${appId}:attempt2`,
      idempotencyKey: 'authority2',
      binding: six.binding,
      answerGoalId: 'goal2',
      attemptId: 'attempt2',
      allowed: true,
      authorityVersion: '1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    await native.finishPrepared(answerId, true);
    const context = await prepareWithFreshAuthority(native, `app:${appId}:D1`);
    expect(context?.selectedSourceIds).toEqual(['M1', 'M2', 'M6']);
    if (context)
      await native.finishPrepared(context.id, true, context.claimToken);
    // Runtime event readers must recognize every receipt and retain run correlation.
    const events = await new PostgresRuntimeEventRepository(
      service.db,
    ).listRuntimeEvents({ appId: appId as never, limit: 100 });
    expect(
      events.some((event) => event.eventType === 'source.message.stored'),
    ).toBe(true);
    expect(
      events.find((event) => event.eventType === 'run.completed')
        ?.correlationId,
    ).toBe('goal1');
    const caller = await new PostgresRuntimeEventRepository(
      service.db,
    ).appendRuntimeEvent({
      appId: appId as never,
      runId: runId as never,
      eventType: 'interaction.pending',
      actor: 'agent',
      payload: {
        interactionType: 'caller_resolved_tool',
        interactionId: 'evidence1',
        toolName: 'search_tender_evidence',
        input: { queries: ['known fact'] },
      },
    });
    expect(caller.sessionId).toBe(sessionId);
    expect(caller.correlationId).toBe('goal1');
    expect(caller.payload).toMatchObject({
      answerGoalId: 'goal1',
      attemptId: 'attempt1',
    });
  });

  it('resumes bounded missing history from persisted interaction state and rejects empty progress pages', async () => {
    const session = await control.ensureAppSession({
      appId,
      conversationId: 'D2',
      chatJid: `app:${appId}:D2`,
      workspaceFolder: 'native-chat-test',
    });
    const source = (position: string) => {
      const row = make(position, `D2M${position}`);
      row.binding = {
        discussionId: 'D2',
        generation: 1,
        workspaceId: 'W2',
        tenderId: 'T2',
      };
      return row;
    };
    await control.appendSourceMessage(appId, session.sessionId, source('1'));
    await control.appendSourceMessage(appId, session.sessionId, source('3'));
    const request = {
      binding: source('3').binding,
      authority: {
        authorityId: 'people',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: 'person1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      questionSourceId: 'D2M3',
      sourceCutoff: '3',
      requesterId: 'person1',
      answerGoalId: 'history-goal',
      attemptId: 'history-attempt',
      idempotencyKey: 'history-answer',
      revisionId: 'R1',
      analysisReady: true as const,
      model: 'haiku',
      maxOutputTokens: 2000,
      deadlineAt: '2027-01-01T00:00:00.000Z',
    };
    await control.requestSourceAnswer(appId, session.sessionId, request);
    const interactionId = `history:source-answer:${appId}:history-attempt:1`;
    const restart = new PostgresControlPlaneRepository(service.db);
    await expect(
      restart.settleSourceHistory(appId, session.sessionId, {
        interactionId,
        idempotencyKey: 'history-page',
        binding: request.binding,
        sourceVersion: 'R1',
        status: 'ok',
        messages: [],
        returnedThrough: '1',
        hasMore: true,
      }),
    ).rejects.toThrow(/advance/);
    const page = {
      interactionId,
      idempotencyKey: 'history-page',
      binding: request.binding,
      sourceVersion: 'R1',
      status: 'ok' as const,
      messages: [source('2').message],
      returnedThrough: '2',
      hasMore: false,
    };
    expect(
      await restart.settleSourceHistory(appId, session.sessionId, page),
    ).toMatchObject({ accepted: true, replayed: false });
    expect(
      await restart.settleSourceHistory(appId, session.sessionId, page),
    ).toMatchObject({ replayed: true });
    await expect(
      restart.settleSourceHistory(appId, session.sessionId, {
        ...page,
        returnedThrough: '3',
      }),
    ).rejects.toThrow(/conflict/);
    await restart.settleExecutionAuthority(appId, session.sessionId, {
      interactionId: `authority:source-answer:${appId}:history-attempt`,
      idempotencyKey: 'deny',
      binding: request.binding,
      answerGoalId: request.answerGoalId,
      attemptId: request.attemptId,
      allowed: false,
      authorityVersion: 'revoked',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const events = await new PostgresRuntimeEventRepository(
      service.db,
    ).listRuntimeEvents({ appId: appId as never, limit: 100 });
    expect(
      events.find(
        (row) =>
          row.eventType === 'source.answer.canceled' &&
          row.correlationId === request.answerGoalId,
      )?.sessionId,
    ).toBe(session.sessionId);
  });
  it('automatically recalls canonical saved workspace/personal subjects and preserves explicit learning under concurrency', async () => {
    const session = (await control.getAppSessionById(sessionId))!;
    const memory = new AppMemoryService(service.db);
    const subject = sourceChannelMemorySubject({
      appId,
      agentId: session.agentId,
      workspaceId: 'W1',
      scope: 'group',
    });
    await memory.save({
      ...subject,
      kind: 'preference',
      key: 'process',
      value: 'Check both stages',
      source: 'discussion-explicit',
      sourceLearningWrite: 'explicit',
    });
    const native = new PostgresSourceAnswerRepository(service.db);
    const recall = await native.memoryContext({
      answerId: 'none',
      appId,
      agentId: session.agentId,
      workspaceId: 'W1',
      personId: 'person1',
    });
    expect(recall).toContain('Check both stages');
    expect(
      await native.memoryContext({
        answerId: 'none',
        appId,
        agentId: session.agentId,
        workspaceId: 'W2',
        personId: 'person1',
      }),
    ).not.toContain('Check both stages');
    const personal = sourceChannelMemorySubject({
      appId,
      agentId: session.agentId,
      workspaceId: 'W1',
      personId: 'person1',
      scope: 'user',
    });
    await memory.save({
      ...personal,
      kind: 'preference',
      key: 'chat_style',
      value: 'Use short chat answers',
      source: 'discussion-explicit',
      sourceLearningWrite: 'explicit',
    });
    expect(
      await native.memoryContext({
        answerId: 'none',
        appId,
        agentId: session.agentId,
        workspaceId: 'W1',
        personId: 'person1',
      }),
    ).toContain('Use short chat answers');
    expect(
      await native.memoryContext({
        answerId: 'none',
        appId,
        agentId: session.agentId,
        workspaceId: 'W1',
        personId: 'person2',
      }),
    ).not.toContain('Use short chat answers');
    expect(
      await native.memoryContext({
        answerId: 'none',
        appId,
        agentId: session.agentId,
        workspaceId: 'W2',
        personId: 'person1',
      }),
    ).not.toContain('Use short chat answers');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        memory.save({
          ...subject,
          kind: 'preference',
          key: 'process',
          value: `inferred ${i}`,
          source: 'discussion-inferred',
          sourceLearningWrite: 'inferred',
        }),
      ),
    );
    expect(results.every((row) => row.status === 'rejected')).toBe(true);
    const records = await memory.list({
      ...subject,
      includeCommon: false,
      limit: 100,
    });
    expect(records.find((row) => row.key === 'process')?.value).toBe(
      'Check both stages',
    );
    // Whichever writer takes the exact-key lock first, explicit correction wins.
    await Promise.allSettled([
      memory.save({
        ...subject,
        kind: 'preference',
        key: 'race',
        value: 'inference',
        source: 'discussion-inferred',
        sourceLearningWrite: 'inferred',
      }),
      memory.save({
        ...subject,
        kind: 'preference',
        key: 'race',
        value: 'explicit correction',
        source: 'discussion-explicit',
        sourceLearningWrite: 'explicit',
      }),
    ]);
    expect(
      (
        await memory.list({ ...subject, includeCommon: false, limit: 100 })
      ).find((row) => row.key === 'race')?.value,
    ).toBe('explicit correction');
  });
  it('keeps repeated goal/attempt output identities separate across applications', () => {
    expect(sourceAnswerOutputId('app-A', 'same-goal', 'same-attempt')).not.toBe(
      sourceAnswerOutputId('app-B', 'same-goal', 'same-attempt'),
    );
    expect(sourceAnswerOutputId('app-A', 'goal-A', 'same-attempt')).not.toBe(
      sourceAnswerOutputId('app-A', 'goal-B', 'same-attempt'),
    );
  });

  it('rebuilds exactly one generation, fences old attempts and replays raw history without native admission', async () => {
    const input = {
      binding: make('1').binding,
      nextGeneration: 2,
      idempotencyKey: 'repair1',
      reason: 'Authorized validation repair',
    };
    const before = (
      await service.db.execute(
        sql`SELECT count(*)::int AS n FROM live_admission_work_items WHERE app_id=${appId}`,
      )
    ).rows[0]!.n;
    const rebuilt = await control.rebuildSourceGeneration(
      appId,
      sessionId,
      input,
    );
    expect(rebuilt.binding.generation).toBe(2);
    expect(rebuilt.contiguousPosition).toBe('0');
    expect(
      await control.rebuildSourceGeneration(appId, sessionId, input),
    ).toMatchObject({ ...rebuilt, replayed: true });
    await expect(
      control.appendSourceMessage(appId, sessionId, make('1')),
    ).rejects.toThrow(/generation/);
    const next = make('1');
    next.binding.generation = 2;
    const saved = await control.appendSourceMessage(appId, sessionId, next);
    expect(saved.generation).toBe(2);
    expect(saved.contiguousPosition).toBe('1');
    expect(
      await service.db
        .select()
        .from(schema.messagesPostgres)
        .where(
          and(
            eq(schema.messagesPostgres.appId, appId),
            eq(schema.messagesPostgres.sourceMessageId, 'M1'),
          ),
        ),
    ).toHaveLength(2);
    expect(
      (
        await service.db.execute(
          sql`SELECT count(*)::int AS n FROM live_admission_work_items WHERE app_id=${appId}`,
        )
      ).rows[0]!.n,
    ).toBe(before);
    expect(
      await new PostgresCanonicalMessageRepository(
        service.db,
      ).listInboundMessages({ jids: [`app:${appId}:D1`] }),
    ).toEqual([]);
  });

  it('creates the first native config through explicit app-admin source provisioning', async () => {
    const agentId = `agent:${appId}:fresh`;
    await service.db
      .insert(schema.agentsPostgres)
      .values({ id: agentId, appId, name: 'Fresh source agent' });
    const receipt = await control.configureSourceChannelProfile(
      appId,
      agentId,
      {
        instructionsVersion: 'test-v1',
        responseSchema: { type: 'object' },
        callerResolvedTools: [],
        maxToolInteractions: 1,
        interactionTimeoutMs: 1000,
      },
      4,
    );
    expect(receipt.effectiveConcurrency).toBe(4);
    const [agent] = await service.db
      .select()
      .from(schema.agentsPostgres)
      .where(eq(schema.agentsPostgres.id, agentId));
    expect(agent?.currentConfigVersionId).toBeTruthy();
  });
  it('retains native config across desired-state agent saves and re-provisions after a historical cleared pointer', async () => {
    const agentId = `agent:${appId}:fresh`;
    const [before] = await service.db
      .select()
      .from(schema.agentsPostgres)
      .where(eq(schema.agentsPostgres.id, agentId));
    expect(before?.currentConfigVersionId).toBeTruthy();
    await new PostgresAgentRepository(service.db).saveAgent({
      id: agentId as never,
      appId: appId as never,
      name: 'Fresh source agent',
      status: 'active',
      createdAt: before!.createdAt,
      updatedAt: new Date().toISOString(),
    });
    const [saved] = await service.db
      .select()
      .from(schema.agentsPostgres)
      .where(eq(schema.agentsPostgres.id, agentId));
    expect(saved?.currentConfigVersionId).toBe(before!.currentConfigVersionId);
    // Simulate the prior released projection defect without patching operator data.
    await service.db
      .update(schema.agentsPostgres)
      .set({ currentConfigVersionId: null })
      .where(eq(schema.agentsPostgres.id, agentId));
    await control.configureSourceChannelProfile(
      appId,
      agentId,
      {
        instructionsVersion: 'test-v1',
        responseSchema: { type: 'object' },
        callerResolvedTools: [],
        maxToolInteractions: 1,
        interactionTimeoutMs: 1000,
      },
      4,
    );
    const [recovered] = await service.db
      .select()
      .from(schema.agentsPostgres)
      .where(eq(schema.agentsPostgres.id, agentId));
    expect(recovered?.currentConfigVersionId).toBe(
      before!.currentConfigVersionId,
    );
  });
  it('builds durable source-only summaries with exact generation and scope coverage', async () => {
    for (let pos = 2; pos <= 90; pos++) {
      const row = make(String(pos), `G2M${pos}`, `message ${pos}`);
      row.binding.generation = 2;
      await control.appendSourceMessage(appId, sessionId, row);
    }
    const request = {
      binding: { ...make('1').binding, generation: 2 },
      authority: {
        authorityId: 'people',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: 'person1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      questionSourceId: 'G2M90',
      sourceCutoff: '90',
      requesterId: 'person1',
      answerGoalId: 'long-goal',
      attemptId: 'long-attempt',
      idempotencyKey: 'long-attempt',
      revisionId: 'R1',
      analysisReady: true as const,
      model: 'haiku',
      maxOutputTokens: 2000,
      deadlineAt: '2027-01-01T00:00:00.000Z',
    };
    await control.requestSourceAnswer(appId, sessionId, request);
    await control.settleExecutionAuthority(appId, sessionId, {
      binding: request.binding,
      interactionId: `authority:source-answer:${appId}:long-attempt`,
      idempotencyKey: 'long-admission',
      answerGoalId: request.answerGoalId,
      attemptId: request.attemptId,
      allowed: true,
      authorityVersion: '1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const native = new PostgresSourceAnswerRepository(service.db);
    const prepared = await prepareWithFreshAuthority(native, `app:${appId}:D1`);
    expect(prepared?.messages).toHaveLength(20);
    expect(prepared?.summaryWork?.sourceIds).toHaveLength(70);
    expect(prepared?.summaryWork?.generation).toBe(2);
    expect(prepared?.summaryWork?.mode).toBe('recent');
    const work = prepared!.summaryWork!;
    await native.saveSummary({
      answerId: prepared!.id,
      claimToken: prepared!.claimToken,
      work,
      text: 'Scoped earlier discussion',
      usage: [],
    });
    expect(await native.readSummary(work.id)).toBe('Scoped earlier discussion');
    const [digest] = await service.db
      .select()
      .from(schema.agentSessionDigestsPostgres)
      .where(eq(schema.agentSessionDigestsPostgres.id, work.id));
    expect(digest?.metadataJson).toMatchObject({
      generation: 2,
      workspaceId: 'W1',
      successfulAnswer: false,
      coveredRange: { after: '0', through: '70' },
    });
    expect(await native.recoverRun('unknown-run')).toBeUndefined();
    await native.finishPrepared(prepared!.id, false, prepared!.claimToken);
  });

  it('denies execution after queued membership revocation before any provider run', async () => {
    const session = await control.ensureAppSession({
      appId,
      conversationId: 'revoked',
      chatJid: `app:${appId}:revoked`,
      workspaceFolder: 'native-chat-test',
    });
    const row = make('1', 'revoked-question');
    row.binding.discussionId = 'revoked';
    await control.appendSourceMessage(appId, session.sessionId, row);
    const request = {
      binding: row.binding,
      authority: {
        authorityId: 'people',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: 'person1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      questionSourceId: 'revoked-question',
      sourceCutoff: '1',
      requesterId: 'person1',
      answerGoalId: 'revoked-goal',
      attemptId: 'revoked-attempt',
      idempotencyKey: 'revoked-attempt',
      revisionId: 'R1',
      analysisReady: true as const,
      model: 'haiku',
      maxOutputTokens: 2000,
      deadlineAt: '2027-01-01T00:00:00.000Z',
    };
    await control.requestSourceAnswer(appId, session.sessionId, request);
    const base = {
      binding: row.binding,
      answerGoalId: request.answerGoalId,
      attemptId: request.attemptId,
      authorityVersion: '1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    await control.settleExecutionAuthority(appId, session.sessionId, {
      ...base,
      interactionId: `authority:source-answer:${appId}:revoked-attempt`,
      idempotencyKey: 'revoke-admission',
      allowed: true,
    });
    const native = new PostgresSourceAnswerRepository(service.db);
    expect(
      await native.prepared(appId, `app:${appId}:revoked`),
    ).toBeUndefined();
    const [execution] = await service.db
      .select()
      .from(schema.pendingInteractionsPostgres)
      .where(
        and(
          eq(schema.pendingInteractionsPostgres.appId, appId),
          sql`${schema.pendingInteractionsPostgres.payloadJson}#>>'{request,answerGoalId}' = 'revoked-goal'`,
          sql`${schema.pendingInteractionsPostgres.payloadJson}#>>'{request,phase}' = 'execution'`,
        ),
      );
    expect(execution).toBeTruthy();
    await control.settleExecutionAuthority(appId, session.sessionId, {
      ...base,
      interactionId: execution!.id,
      idempotencyKey: 'revoked-execution',
      allowed: false,
    });
    expect(
      await native.prepared(appId, `app:${appId}:revoked`),
    ).toBeUndefined();
    const [answer] = await service.db
      .select()
      .from(schema.pendingInteractionsPostgres)
      .where(
        eq(
          schema.pendingInteractionsPostgres.id,
          `source-answer:${appId}:revoked-attempt`,
        ),
      );
    expect(answer?.runId).toBeNull();
    expect(answer?.status).toBe('cancelled');
  });
  it('persists and terminates the same goal/attempt independently in a second application', async () => {
    const other = `source-other-${randomUUID()}`;
    const folder = `other-${randomUUID()}`;
    try {
      const session = await control.ensureAppSession({
        appId: other,
        conversationId: 'D1',
        chatJid: `app:${other}:D1`,
        workspaceFolder: folder,
      });
      const row = make('1');
      await control.appendSourceMessage(other, session.sessionId, row);
      const request = {
        binding: row.binding,
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
        answerGoalId: 'goal1',
        attemptId: 'attempt1',
        idempotencyKey: 'attempt1',
        revisionId: 'R1',
        analysisReady: true as const,
        model: 'haiku',
        maxOutputTokens: 2000,
        deadlineAt: '2027-01-01T00:00:00.000Z',
      };
      await control.requestSourceAnswer(other, session.sessionId, request);
      const settlement = {
        binding: row.binding,
        answerGoalId: 'goal1',
        attemptId: 'attempt1',
        allowed: true,
        authorityVersion: '1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      };
      await control.settleExecutionAuthority(other, session.sessionId, {
        ...settlement,
        interactionId: `authority:source-answer:${other}:attempt1`,
        idempotencyKey: 'other-admit',
      });
      const native = new PostgresSourceAnswerRepository(service.db);
      expect(await native.prepared(other, `app:${other}:D1`)).toBeUndefined();
      const [execution] = await service.db
        .select()
        .from(schema.pendingInteractionsPostgres)
        .where(
          and(
            eq(schema.pendingInteractionsPostgres.appId, other),
            sql`${schema.pendingInteractionsPostgres.payloadJson}#>>'{request,phase}' = 'execution'`,
          ),
        );
      await control.settleExecutionAuthority(other, session.sessionId, {
        ...settlement,
        interactionId: execution!.id,
        idempotencyKey: 'other-execution',
      });
      const prepared = await native.prepared(other, `app:${other}:D1`);
      expect(prepared).toBeTruthy();
      await new PostgresCanonicalSessionRepository(
        service.db,
      ).getAgentTurnContext({
        appId: other,
        workspaceFolder: folder,
        executionProviderId: 'anthropic:claude-agent-sdk',
        chatJid: `app:${other}:D1`,
        providerAccountId: `control:${other}`,
        scopeKey: 'other-source',
        conversationKind: 'channel',
        memoryUserId: 'person1',
      });
      const [agent] = await service.db
        .select()
        .from(schema.agentsPostgres)
        .where(eq(schema.agentsPostgres.id, session.agentId));
      const [config] = await service.db
        .select()
        .from(schema.agentConfigVersionsPostgres)
        .where(
          eq(
            schema.agentConfigVersionsPostgres.id,
            agent!.currentConfigVersionId!,
          ),
        );
      const runId = `run-${randomUUID()}`;
      await service.db.insert(schema.agentRunsPostgres).values({
        id: runId,
        appId: other,
        agentId: session.agentId,
        configVersionId: config!.id,
        sessionId: session.sessionId,
        conversationId: session.canonicalConversationId,
        llmProfileId: config!.llmProfileId,
        executionProviderId: 'anthropic:claude-agent-sdk',
        cause: 'message',
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      await native.markRun(prepared!.id, runId);
      await native.output(
        prepared!.id,
        runId,
        'Second application full result',
      );
      await service.db.transaction((tx) =>
        appendSourceAnswerTerminal(
          tx,
          runId,
          'completed',
          new Date().toISOString(),
        ),
      );
      const outputs = await service.db
        .select()
        .from(schema.messagesPostgres)
        .where(
          sql`${schema.messagesPostgres.id} IN (${sourceAnswerOutputId(appId, 'goal1', 'attempt1')},${sourceAnswerOutputId(other, 'goal1', 'attempt1')})`,
        );
      expect(outputs).toHaveLength(2);
      expect(new Set(outputs.map((item) => item.appId)).size).toBe(2);
      const events = await new PostgresRuntimeEventRepository(
        service.db,
      ).listRuntimeEvents({ appId: other as never, limit: 100 });
      expect(
        events.find((event) => event.eventType === 'run.completed')?.payload,
      ).toMatchObject({
        runtimeOutputId: sourceAnswerOutputId(other, 'goal1', 'attempt1'),
      });
    } finally {
      await service.db
        .delete(schema.appsPostgres)
        .where(eq(schema.appsPostgres.id, other));
    }
  });
});

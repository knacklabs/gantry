import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresFileArtifactStore } from '../../../src/adapters/storage/postgres/repositories/file-artifact-repository.postgres.js';
import { LocalFileArtifactBytes } from '../../../src/adapters/artifacts/files/local-file-artifact-bytes.js';
import { readSourceDocumentForSession } from '../../../src/adapters/storage/postgres/repositories/source-document-read.postgres.js';
import { createSourceDocument } from '../../../src/source-documents/service.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import {
  createClient,
  hashSourceMessage,
} from '../../../../../packages/sdk/src/index.js';
import { PostgresStorageService } from '../../../src/adapters/storage/postgres/storage-service.js';
import { PostgresControlPlaneRepository } from '../../../src/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresSourceAnswerRepository } from '../../../src/adapters/storage/postgres/repositories/source-answer-repository.postgres.js';
import { PostgresSourceLearningRepository } from '../../../src/adapters/storage/postgres/repositories/source-learning-repository.postgres.js';
import { SessionInteractionModule } from '../../../src/application/sessions/session-interaction-module.js';
import { adaptSessionControlPort } from '../../../src/control/server/session-control-port.js';
import { handleSessionRoutes } from '../../../src/control/server/routes/sessions.js';
import { AppMemoryService } from '../../../src/memory/app-memory-service.js';
import { sourceChannelMemorySubject } from '../../../src/memory/source-channel-memory-scope.js';
import {
  saveSourceLearning,
  forgetSourceLearning,
} from '../../../src/memory/source-learning-service.js';
import * as s from '../../../src/adapters/storage/postgres/schema/schema.js';
const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('source learning activation through durable SDK authority', () => {
  const appId = `learning-${randomUUID()}`;
  const folder = `learning-${randomUUID()}`;
  let db: PostgresStorageService;
  let fileStore: PostgresFileArtifactStore;
  let fileRoot: string;
  let control: PostgresControlPlaneRepository;
  let native: PostgresSourceAnswerRepository;
  let memory: AppMemoryService;
  let sdk: ReturnType<typeof createClient>;
  let server: ReturnType<typeof createServer>;
  let pump: ReturnType<typeof setInterval>;
  let denyPublication = false;
  const handled = new Set<string>();
  let pumping = false;
  beforeAll(async () => {
    db = new PostgresStorageService(process.env.GANTRY_DATABASE_URL!, 'gantry');
    await db.migrate();
    control = new PostgresControlPlaneRepository(db.db);
    native = new PostgresSourceAnswerRepository(db.db);
    memory = new AppMemoryService(db.db);
    fileRoot = await mkdtemp(path.join(tmpdir(), 'native-source-documents-'));
    fileStore = new PostgresFileArtifactStore(
      db.db,
      new LocalFileArtifactBytes(fileRoot),
    );
    const controlPort = adaptSessionControlPort(control);
    controlPort.readSourceDocument = (a, id, input) =>
      readSourceDocumentForSession(db.db, a, id, input, fileStore);
    const token = randomUUID();
    const module = new SessionInteractionModule({
      control: controlPort,
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
          kid: 'learning-test',
          tokenHash: createHash('sha256').update(token).digest(),
          scopes: new Set(['sessions:write', 'sessions:read']),
          appId,
        },
      ],
      sessionInteraction: module,
    } as never;
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      void handleSessionRoutes(req, res, ctx, url, url.pathname)
        .then((ok) => {
          if (!ok) {
            res.statusCode = 404;
            res.end();
          }
        })
        .catch(() => {
          res.statusCode = 500;
          res.end();
        });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture HTTP missing');
    sdk = createClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: token,
    });
    pump = setInterval(() => {
      if (pumping) return;
      pumping = true;
      void (async () => {
        const rows = await db.db
          .select()
          .from(s.pendingInteractionsPostgres)
          .where(
            and(
              eq(s.pendingInteractionsPostgres.appId, appId),
              eq(s.pendingInteractionsPostgres.status, 'pending'),
              sql`${s.pendingInteractionsPostgres.payloadJson}#>>'{request,interactionType}'='execution_authority'`,
            ),
          );
        for (const row of rows) {
          if (handled.has(row.id)) continue;
          handled.add(row.id);
          const request = (row.payloadJson as any).request;
          const [session] = await db.db
            .select()
            .from(s.controlHttpSessionsPostgres)
            .where(
              and(
                eq(s.controlHttpSessionsPostgres.appId, appId),
                eq(
                  s.controlHttpSessionsPostgres.externalConversationId,
                  request.binding.discussionId,
                ),
              ),
            );
          await sdk.sessions.settleExecutionAuthority(session!.sessionId, {
            interactionId: row.id,
            idempotencyKey: `settle-${row.id}`,
            binding: request.binding,
            answerGoalId: request.answerGoalId,
            attemptId: request.attemptId,
            allowed: !(denyPublication && request.phase === 'publication'),
            authorityVersion: '1',
            expiresAt: new Date(Date.now() + 4000).toISOString(),
          });
        }
      })().finally(() => {
        pumping = false;
      });
    }, 25);
  }, 60000);
  afterAll(async () => {
    if (pump) clearInterval(pump);
    while (pumping) await new Promise((r) => setTimeout(r, 20));
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db) {
      await db.db.delete(s.appsPostgres).where(eq(s.appsPostgres.id, appId));
      await db.close();
      if (fileRoot) await rm(fileRoot, { recursive: true, force: true });
    }
  });
  async function attempt(texts: string[], personId = 'person1') {
    const discussionId = `D-${randomUUID()}`;
    const session = await control.ensureAppSession({
      appId,
      conversationId: discussionId,
      chatJid: `app:${appId}:${discussionId}`,
      workspaceFolder: folder,
    });
    const binding = {
      discussionId,
      generation: 1,
      workspaceId: 'W1',
      tenderId: 'T1',
    };
    for (let i = 0; i < texts.length; i++) {
      const message = {
        sourceMessageId: `M${i + 1}`,
        sourcePosition: String(i + 1),
        authorId: personId,
        authorKind: 'human' as const,
        authorDisplayName: 'Person',
        text: texts[i]!,
        createdAt: new Date().toISOString(),
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
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
        message: { ...message, contentHash: hashSourceMessage(message) },
        idempotencyKey: `delivery-M${i + 1}`,
      });
    }
    const attemptId = randomUUID();
    const request = {
      binding,
      authority: {
        authorityId: 'person',
        authorityVersion: '1',
        kind: 'person' as const,
        subject: personId,
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      questionSourceId: `M${texts.length}`,
      sourceCutoff: String(texts.length),
      requesterId: personId,
      answerGoalId: randomUUID(),
      attemptId,
      idempotencyKey: attemptId,
      revisionId: 'R1',
      analysisReady: true as const,
      model: 'haiku',
      maxOutputTokens: 2000,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
    };
    await control.requestSourceAnswer(appId, session.sessionId, request);
    let prepared;
    for (let i = 0; i < 80 && !prepared; i++) {
      prepared = await native.prepared(appId, `app:${appId}:${discussionId}`);
      if (!prepared) await new Promise((r) => setTimeout(r, 30));
    }
    if (!prepared) throw new Error('fixture source admission failed');
    const [agent] = await db.db
      .select()
      .from(s.agentsPostgres)
      .where(eq(s.agentsPostgres.id, session.agentId));
    const [config] = await db.db
      .select()
      .from(s.agentConfigVersionsPostgres)
      .where(
        eq(s.agentConfigVersionsPostgres.id, agent!.currentConfigVersionId!),
      );
    const runId = `run-${randomUUID()}`;
    await db.db.insert(s.agentRunsPostgres).values({
      id: runId,
      appId,
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
    await native.markRun(prepared.id, runId);
    return {
      prepared,
      scope: {
        appId,
        agentId: session.agentId,
        chatJid: `app:${appId}:${discussionId}`,
        personId,
        workspaceId: 'W1',
        runId,
      },
      finish: () =>
        native.finishPrepared(prepared!.id, false, prepared!.claimToken),
    };
  }
  const allowed = (ids: string[], grounding = 'explicit_instruction') => ({
    decision: 'allow',
    reusable: true,
    tenderFact: false,
    sensitiveProfile: false,
    scopeAppropriate: true,
    grounding,
    confidence: 0.99,
    supportingSourceIds: ids,
    reason: 'General supported instruction',
  });
  it('registers only host-rendered goal-bound bytes and reads them through the actual session SDK boundary', async () => {
    const a = await attempt(['Generate a PDF with a basic unconfirmed note.']);
    const bytes = Buffer.from('%PDF-1.7\nNative source document');
    let renders = 0;
    const document = {
      version: 1 as const,
      format: 'pdf' as const,
      fileName: 'answer.pdf',
      title: 'Answer',
      blocks: [{ type: 'paragraph' as const, text: 'Unconfirmed note' }],
    };
    const launch = async () => {
      renders++;
      return {
        bytes,
        result: {
          version: 1 as const,
          rendererVersion: 'fixture-v1',
          fileName: 'answer.pdf',
          contentType: 'application/pdf' as const,
          bytesBase64: bytes.toString('base64'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
        },
      };
    };
    const input = {
      scope: a.scope,
      document,
      citationIds: [],
      metadataFields: [],
      store: fileStore,
      repository: new PostgresSourceLearningRepository(db.db),
      launch,
    };
    try {
      const receipt = await createSourceDocument(input);
      expect(receipt.runId).toBe(a.scope.runId);
      expect(JSON.stringify(receipt)).not.toContain(bytes.toString('base64'));
      expect(await createSourceDocument(input)).toEqual(receipt);
      expect(renders).toBe(1);
      const body = {
        artifactId: receipt.artifactId,
        answerGoalId: receipt.answerGoalId,
        attemptId: receipt.attemptId,
        binding: receipt.binding,
      };
      const read = await sdk.sessions.readSourceDocument(
        receipt.sessionId,
        body,
      );
      expect(Buffer.from(read.bytesBase64, 'base64')).toEqual(bytes);
      expect(read.receipt).toEqual(receipt);
      await expect(
        sdk.sessions.readSourceDocument(receipt.sessionId, {
          ...body,
          attemptId: 'foreign',
        }),
      ).rejects.toThrow();
      await expect(
        native.output(
          a.prepared.id,
          a.scope.runId,
          JSON.stringify({ artifacts: [{ ...receipt, runId: 'foreign' }] }),
        ),
      ).rejects.toThrow(/receipt/);
      await native.output(
        a.prepared.id,
        a.scope.runId,
        JSON.stringify({ artifacts: [receipt] }),
      );
      await expect(
        createSourceDocument({
          ...input,
          document: { ...document, title: 'Second' },
        }),
      ).resolves.toMatchObject({ format: 'pdf' });
      for(const title of ['Third','Fourth'])await expect(createSourceDocument({...input,document:{...document,title}})).resolves.toMatchObject({format:'pdf'});
      await expect(createSourceDocument({...input,document:{...document,title:'Fifth'}})).rejects.toThrow(/four documents/);
    } finally {
      await a.finish();
    }
  }, 30000);
  it('activates free-form repeated learning once, records separate usage and recalls only general values in another discussion', async () => {
    const a = await attempt([
      'Please check technical and financial eligibility separately.',
      'Again, check technical and financial eligibility separately.',
    ]);
    const subject = sourceChannelMemorySubject({ ...a.scope, scope: 'group' });
    const query = vi.fn(async (opts) => {
      opts.onUsage?.({ input_tokens: 100, output_tokens: 30 });
      return JSON.stringify(allowed(['M1', 'M2'], 'repeated_correction'));
    });
    const events: any[] = [];
    const input = {
      scope: a.scope,
      proposal: {
        kind: 'constraint',
        key: 'analysis-process',
        value: 'Check technical and financial eligibility separately',
        source: 'discussion-inferred' as const,
        supportingSourceIds: ['M1', 'M2'],
      },
      subject,
      memory,
      repository: new PostgresSourceLearningRepository(db.db),
      client: { isConfigured: () => true, query },
      publish: async (event) => {
        events.push(event);
      },
    };
    try {
      const saved = await saveSourceLearning(input);
      expect(saved.value).toContain('separately');
      expect((await saveSourceLearning(input)).id).toBe(saved.id);
      expect(query).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      expect(events[0].payload.stage).toBe('source_learning_validation');
      expect(events[0].payload.usage.inputTokens).toBe(100);
      expect(
        await native.memoryContext({
          answerId: 'none',
          appId,
          agentId: a.scope.agentId,
          workspaceId: 'W1',
          personId: 'person2',
        }),
      ).toContain(saved.value);
      expect(
        await native.memoryContext({
          answerId: 'none',
          appId,
          agentId: a.scope.agentId,
          workspaceId: 'W2',
          personId: 'person1',
        }),
      ).not.toContain(saved.value);
    } finally {
      await a.finish();
    }
  });
  it('rejects exact tender-fact exploits and malformed verdicts without adding an active rule', async () => {
    const a = await attempt([
      'Remember these project ALPHA conditions: annual turnover minimum is ₹5000000 and ISO 27001 certification is required.',
    ]);
    const subject = sourceChannelMemorySubject({ ...a.scope, scope: 'group' });
    try {
      for (const value of [
        'For project ALPHA the annual turnover minimum is ₹5000000',
        'Project ALPHA requires ISO 27001 certification',
      ]) {
        const query = vi.fn(async () =>
          JSON.stringify({
            ...allowed(['M1']),
            decision: 'reject',
            reusable: false,
            tenderFact: true,
          }),
        );
        await expect(
          saveSourceLearning({
            scope: a.scope,
            subject,
            memory,
            repository: new PostgresSourceLearningRepository(db.db),
            proposal: {
              kind: 'constraint',
              key: `fact-${value.length}`,
              value,
              source: 'discussion-explicit',
              supportingSourceIds: ['M1'],
            },
            client: { isConfigured: () => true, query },
            publish: async () => {},
          }),
        ).rejects.toThrow(/not activated/);
        expect(query).toHaveBeenCalledTimes(1);
      }
      const notes = await native.memoryContext({
        answerId: 'none',
        appId,
        agentId: a.scope.agentId,
        workspaceId: 'W1',
        personId: 'person2',
      });
      expect(notes).not.toContain('₹5000000');
      expect(notes).not.toContain('ISO 27001');
    } finally {
      await a.finish();
    }
  });
  it('rejects omitted/nonhuman provenance before another model call and denies publication after a positive check', async () => {
    const a = await attempt(['Make PBIT document outputs more detailed.']);
    const subject = sourceChannelMemorySubject({ ...a.scope, scope: 'group' });
    const query = vi.fn(async () => JSON.stringify(allowed(['M1'])));
    try {
      await expect(
        saveSourceLearning({
          scope: a.scope,
          subject,
          memory,
          repository: new PostgresSourceLearningRepository(db.db),
          proposal: {
            kind: 'preference',
            key: 'pbit-detail',
            value: 'Make PBIT document outputs more detailed',
            source: 'discussion-explicit',
            supportingSourceIds: ['outside'],
          },
          client: { isConfigured: () => true, query },
          publish: async () => {},
        }),
      ).rejects.toThrow(/source references|omitted|unauthorized/);
      expect(query).not.toHaveBeenCalled();
      denyPublication = true;
      await expect(
        saveSourceLearning({
          scope: a.scope,
          subject,
          memory,
          repository: new PostgresSourceLearningRepository(db.db),
          proposal: {
            kind: 'preference',
            key: 'pbit-detail',
            value: 'Make PBIT document outputs more detailed',
            source: 'discussion-explicit',
            supportingSourceIds: ['M1'],
          },
          client: { isConfigured: () => true, query },
          publish: async () => {},
        }),
      ).rejects.toThrow(/denied|canceled/);
      expect(query).toHaveBeenCalledTimes(1);
      expect(
        (await memory.list({ ...subject, includeCommon: false })).some(
          (row) => row.key === 'pbit-detail',
        ),
      ).toBe(false);
    } finally {
      denyPublication = false;
      await a.finish();
    }
  });
  it('activates only the requester personal style, keeps other scopes separate, and does not revive forgotten learning on replay', async () => {
    const a = await attempt(['I prefer short chat answers.']);
    const subject = sourceChannelMemorySubject({ ...a.scope, scope: 'user' });
    const query = vi.fn(async () => JSON.stringify(allowed(['M1'])));
    const input = {
      scope: a.scope,
      subject,
      memory,
      repository: new PostgresSourceLearningRepository(db.db),
      proposal: {
        kind: 'preference',
        key: 'personal-style',
        value: 'Use short chat answers',
        source: 'discussion-explicit' as const,
        supportingSourceIds: ['M1'],
      },
      client: { isConfigured: () => true, query },
      publish: async () => {},
    };
    try {
      const saved = await saveSourceLearning(input);
      expect(
        await native.memoryContext({
          answerId: 'none',
          appId,
          agentId: a.scope.agentId,
          workspaceId: 'W1',
          personId: 'person1',
        }),
      ).toContain('Use short chat answers');
      expect(
        await native.memoryContext({
          answerId: 'none',
          appId,
          agentId: a.scope.agentId,
          workspaceId: 'W1',
          personId: 'person2',
        }),
      ).not.toContain('Use short chat answers');
      expect(
        await native.memoryContext({
          answerId: 'none',
          appId,
          agentId: a.scope.agentId,
          workspaceId: 'W2',
          personId: 'person1',
        }),
      ).not.toContain('Use short chat answers');
      await forgetSourceLearning({
        scope: a.scope,
        subject,
        id: saved.id,
        expectedVersion: saved.version,
        repository: new PostgresSourceLearningRepository(db.db),
      });
      await expect(saveSourceLearning(input)).rejects.toThrow(
        /forgotten|replaced/,
      );
      expect(query).toHaveBeenCalledTimes(1);
      expect(
        await native.memoryContext({
          answerId: 'none',
          appId,
          agentId: a.scope.agentId,
          workspaceId: 'W1',
          personId: 'person1',
        }),
      ).not.toContain('Use short chat answers');
    } finally {
      await a.finish();
    }
  });
  it('keeps a later explicit correction active even when an inferred classifier verdict says allow', async () => {
    const a = await attempt([
      'Please check technical and financial separately.',
      'For future analysis, review technical and financial together instead.',
    ]);
    const subject = sourceChannelMemorySubject({ ...a.scope, scope: 'group' });
    const before = (
      await memory.list({ ...subject, includeCommon: false })
    ).find((row) => row.key === 'analysis-process')!;
    try {
      const corrected = await saveSourceLearning({
        scope: a.scope,
        subject,
        memory,
        repository: new PostgresSourceLearningRepository(db.db),
        proposal: {
          kind: 'correction',
          key: 'analysis-process',
          value: 'Review technical and financial together',
          source: 'discussion-explicit',
          supportingSourceIds: ['M2'],
        },
        client: {
          isConfigured: () => true,
          query: async () => JSON.stringify(allowed(['M2'])),
        },
        publish: async () => {},
      });
      expect(corrected.id).toBe(before.id);
      await expect(
        saveSourceLearning({
          scope: a.scope,
          subject,
          memory,
          repository: new PostgresSourceLearningRepository(db.db),
          proposal: {
            kind: 'constraint',
            key: 'analysis-process',
            value: 'Check technical and financial eligibility separately',
            source: 'discussion-inferred',
            supportingSourceIds: ['M1', 'M2'],
          },
          client: {
            isConfigured: () => true,
            query: async () =>
              JSON.stringify(allowed(['M1', 'M2'], 'repeated_correction')),
          },
          publish: async () => {},
        }),
      ).rejects.toThrow(/Conflicting inferred/);
      const notes = (
        await memory.list({ ...subject, includeCommon: false })
      ).filter((row) => row.key === 'analysis-process');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.value).toBe('Review technical and financial together');
    } finally {
      await a.finish();
    }
  });
  it('fences activation when the generation changes during the separate check', async () => {
    const a = await attempt(['Use detailed PBIT document outputs.']);
    const subject = sourceChannelMemorySubject({ ...a.scope, scope: 'group' });
    try {
      await expect(
        saveSourceLearning({
          scope: a.scope,
          subject,
          memory,
          repository: new PostgresSourceLearningRepository(db.db),
          proposal: {
            kind: 'preference',
            key: 'generation-fenced-rule',
            value: 'Use detailed PBIT document outputs',
            source: 'discussion-explicit',
            supportingSourceIds: ['M1'],
          },
          client: {
            isConfigured: () => true,
            query: async () => {
              await control.rebuildSourceGeneration(
                appId,
                (
                  await db.db
                    .select()
                    .from(s.controlHttpSessionsPostgres)
                    .where(
                      and(
                        eq(s.controlHttpSessionsPostgres.appId, appId),
                        eq(
                          s.controlHttpSessionsPostgres.externalConversationId,
                          a.scope.chatJid.split(':').at(-1)!,
                        ),
                      ),
                    )
                )[0]!.sessionId,
                {
                  binding: {
                    discussionId: a.scope.chatJid.split(':').at(-1)!,
                    generation: 1,
                    workspaceId: 'W1',
                    tenderId: 'T1',
                  },
                  nextGeneration: 2,
                  idempotencyKey: 'repair-learning',
                  reason: 'Test generation fencing',
                },
              );
              return JSON.stringify(allowed(['M1']));
            },
          },
          publish: async () => {},
        }),
      ).rejects.toThrow(/binding|fenced|invalidated/);
      expect(
        (await memory.list({ ...subject, includeCommon: false })).some(
          (row) => row.key === 'generation-fenced-rule',
        ),
      ).toBe(false);
    } finally {
      await a.finish();
    }
  });
});

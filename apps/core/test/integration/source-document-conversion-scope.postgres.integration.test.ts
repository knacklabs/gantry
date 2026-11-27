import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import * as s from '@core/adapters/storage/postgres/schema/schema.js';
import { configureSourceChannelProfile } from '@core/adapters/storage/postgres/repositories/source-channel-profile.postgres.js';
import { selectedSourceDocument } from '@core/adapters/storage/postgres/repositories/source-document-output.postgres.js';
const run = hasPostgresIntegrationDatabase ? describe : describe.skip;
run('conversion selected published source boundary', () => {
  let runtime: PostgresIntegrationRuntime;
  let context: Parameters<typeof selectedSourceDocument>[1];
  const binding = {
    discussionId: 'D',
    generation: 1,
    workspaceId: 'W',
    tenderId: 'T',
  };
  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'document_conversion',
    });
    const session = await runtime.control.ensureAppSession({
      appId: 'default',
      conversationId: 'D',
      chatJid: 'app:default:D',
      workspaceFolder: 'main_agent',
    });
    await configureSourceChannelProfile(
      runtime.service.db,
      'default',
      session.agentId,
      {
        instructionsVersion: 'fixture',
        responseSchema: { type: 'object' },
        callerResolvedTools: [],
        maxToolInteractions: 1,
        interactionTimeoutMs: 1000,
      },
      1,
    );
    const [agent] = await runtime.service.db
      .select()
      .from(s.agentsPostgres)
      .where(eq(s.agentsPostgres.id, session.agentId));
    const [config] = await runtime.service.db
      .select()
      .from(s.agentConfigVersionsPostgres)
      .where(
        eq(s.agentConfigVersionsPostgres.id, agent!.currentConfigVersionId!),
      );
    const [native] = await runtime.service.db
      .select()
      .from(s.controlHttpSessionsPostgres)
      .where(eq(s.controlHttpSessionsPostgres.sessionId, session.sessionId));
    const request = {
      binding,
      questionSourceId: 'Q',
      sourceCutoff: '2',
      revisionId: 'REV',
      answerGoalId: 'new-goal',
      attemptId: 'new-attempt',
    } as never;
    context = {
      answerId: 'current',
      sessionId: session.sessionId,
      conversationId: native!.conversationId,
      request,
      scope: { appId: 'default', runId: 'CURRENT' },
    };
    for (const id of ['ORIGINAL', 'CURRENT'])
      await runtime.service.db
        .insert(s.agentRunsPostgres)
        .values({
          id,
          appId: 'default',
          agentId: session.agentId,
          configVersionId: config!.id,
          sessionId: session.sessionId,
          conversationId: native!.conversationId,
          llmProfileId: config!.llmProfileId,
          executionProviderId: 'anthropic:claude-agent-sdk',
          cause: 'message',
          status: id === 'CURRENT' ? 'running' : 'completed',
          createdAt: new Date().toISOString(),
        });
    const receipt = {
      artifactId: 'FILE',
      sessionId: session.sessionId,
      runId: 'ORIGINAL',
      answerGoalId: 'old-goal',
      attemptId: 'old-attempt',
      binding,
      format: 'pdf',
      fileName: 'file.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      rendererVersion: 'fixture',
      manifestHash: 'b'.repeat(64),
      citationIds: [],
      metadataFields: [],
    };
    await runtime.service.db
      .insert(s.messagesPostgres)
      .values({
        id: 'native-output',
        appId: 'default',
        providerId: 'app',
        providerAccountId: 'control:default',
        conversationId: native!.conversationId,
        direction: 'outbound',
        trust: 'system',
        createdAt: new Date().toISOString(),
        sourceMessageId: 'HOST-PUBLISHED-UUID',
        sourcePosition: 1n,
        sourceGeneration: 1,
        sourceContentHash: 'c'.repeat(64),
        externalRefJson: {
          sourceAnswerGoalId: 'old-goal',
          sourceRunId: 'ORIGINAL',
          sourceArtifacts: [receipt],
        },
      });
    for (const id of ['original', 'current'])
      await runtime.service.db
        .insert(s.pendingInteractionsPostgres)
        .values({
          id,
          appId: 'default',
          runId: id === 'current' ? 'CURRENT' : 'ORIGINAL',
          kind: 'question',
          status: id === 'current' ? 'pending' : 'resolved',
          idempotencyKey: id,
          payloadJson: {
            interactionType: 'source_answer',
            request: {
              ...request,
              answerGoalId: id === 'current' ? 'new-goal' : 'old-goal',
              attemptId: id === 'current' ? 'new-attempt' : 'old-attempt',
            },
            contextSnapshot: {
              selectedSourceIds: ['Q', 'HOST-PUBLISHED-UUID'],
            },
          },
          createdAt: new Date().toISOString(),
          expiresAt: '2027-01-01T00:00:00.000Z',
        });
  }, 60000);
  afterAll(async () => {
    if (runtime) {
      await runtime.storageRuntime.runtimeEventNotifier.close();
      await runtime.cleanup();
    }
  });
  it('returns the exact selected original host source ID and denies unselected, foreign and old-revision use', async () => {
    expect(
      await selectedSourceDocument(runtime.service.db, context, 'FILE'),
    ).toMatchObject({
      sourceMessageId: 'HOST-PUBLISHED-UUID',
      receipt: { artifactId: 'FILE' },
    });
    await expect(
      selectedSourceDocument(
        runtime.service.db,
        {
          ...context,
          request: {
            ...context.request,
            binding: { ...binding, workspaceId: 'OTHER' },
          },
        },
        'FILE',
      ),
    ).rejects.toThrow(/ownership/);
    await expect(
      selectedSourceDocument(
        runtime.service.db,
        { ...context, request: { ...context.request, revisionId: 'NEXT' } },
        'FILE',
      ),
    ).rejects.toThrow(/revision/);
    await runtime.service.db
      .update(s.pendingInteractionsPostgres)
      .set({
        payloadJson: {
          interactionType: 'source_answer',
          request: context.request,
          contextSnapshot: { selectedSourceIds: ['Q'] },
        },
      })
      .where(eq(s.pendingInteractionsPostgres.id, 'current'));
    await expect(
      selectedSourceDocument(runtime.service.db, context, 'FILE'),
    ).rejects.toThrow(/outside/);
  });
});

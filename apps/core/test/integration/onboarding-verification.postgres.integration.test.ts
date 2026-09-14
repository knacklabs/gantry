import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresOnboardingSetupRepository } from '@core/adapters/storage/postgres/repositories/onboarding-setup-repository.postgres.js';
import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import {
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import {
  agentConfigVersionsPostgres,
  agentsPostgres,
  customRolesPostgres,
  onboardingSetupsPostgres,
  onboardingVerificationsPostgres,
  runtimeEventsPostgres,
  usersPostgres,
} from '@core/adapters/storage/postgres/schema/schema.js';
import {
  invalidateOnboardingProgress,
  OnboardingSetupService,
} from '@core/application/onboarding/onboarding-setup.service.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const appId = DEFAULT_APP_ID as never;
const providerAccountId = 'provider-account:onboarding:slack' as never;
const conversationId = 'conversation:onboarding:slack:C123' as never;
const otherConversationId = 'conversation:onboarding:slack:C456' as never;
const threadId = 'thread:onboarding:slack:C123:1700.1' as never;
const now = '2099-09-14T00:00:00.000Z';

maybeDescribe('onboarding verification persistence', () => {
  let runtime: PostgresIntegrationRuntime;
  let service: OnboardingSetupService;
  let setup: Awaited<ReturnType<OnboardingSetupService['createOrResume']>>;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'onboarding_verification',
    });
    service = new OnboardingSetupService(
      new PostgresOnboardingSetupRepository(runtime.service.db),
      async () => ({ ok: true, message: 'Validated for persistence test.' }),
    );
    setup = await service.createOrResume(setupRequest());
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId: setup.agentId as never,
      providerId: 'slack' as never,
      externalIdentityRef: { kind: 'provider_account', value: 'T123' },
      label: 'Onboarding Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, externalId, kind] of [
      [conversationId, 'C123', 'direct'],
      [otherConversationId, 'C456', 'channel'],
    ] as const) {
      await runtime.repositories.conversations.saveConversation({
        id,
        appId,
        providerAccountId,
        externalRef: { kind: 'conversation', value: externalId },
        kind,
        title: externalId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }
    await runtime.repositories.conversations.saveThread({
      id: threadId,
      appId,
      conversationId,
      externalRef: { kind: 'conversation_thread', value: '1700.1' },
      title: 'Onboarding thread',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('creates one resumable setup and conflicts on changed idempotent replay', async () => {
    const replay = await service.createOrResume(setupRequest());
    expect(replay).toMatchObject({
      setupId: setup.setupId,
      agentId: setup.agentId,
      replayed: true,
    });
    await expect(
      service.createOrResume({ ...setupRequest(), title: 'Changed title' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const [counts] = await runtime.service.db
      .select({
        setups: count(onboardingSetupsPostgres.id),
        agents: count(agentsPostgres.id),
      })
      .from(onboardingSetupsPostgres)
      .innerJoin(
        agentsPostgres,
        eq(agentsPostgres.id, onboardingSetupsPostgres.agentId),
      );
    expect(counts).toEqual({ setups: 1, agents: 1 });
    await expect(
      runtime.service.db
        .select()
        .from(customRolesPostgres)
        .where(eq(customRolesPostgres.appId, appId)),
    ).resolves.toHaveLength(1);
    await expect(
      runtime.service.db
        .select()
        .from(usersPostgres)
        .where(
          and(
            eq(usersPostgres.agentId, setup.agentId),
            eq(usersPostgres.kind, 'service'),
          ),
        ),
    ).resolves.toHaveLength(1);
    await expect(
      runtime.service.db
        .select()
        .from(runtimeEventsPostgres)
        .where(eq(runtimeEventsPostgres.eventType, 'onboarding.setup.created')),
    ).resolves.toHaveLength(1);
  });

  it('invalidates only downstream onboarding progress', () => {
    const complete = {
      modelValidated: true,
      workspaceConnected: true,
      assignmentReady: true,
      verificationSatisfied: true,
      projectionCompleted: true,
    };

    expect(invalidateOnboardingProgress(complete, 'assignment')).toEqual({
      modelValidated: true,
      workspaceConnected: true,
    });
    expect(invalidateOnboardingProgress(complete, 'workspace')).toEqual({
      modelValidated: true,
    });
    expect(invalidateOnboardingProgress(complete, 'model')).toEqual({});
  });

  it('assigns direct and group approvers from the correct provider identities', async () => {
    const graph = new PostgresCanonicalGraphRepository(runtime.service.db);
    await graph.ensureParticipant({
      conversationId,
      providerId: 'slack',
      providerAccountId,
      externalUserId: 'U-DIRECT-COUNTERPART',
      timestamp: now,
    });
    await graph.ensureParticipant({
      conversationId: otherConversationId,
      providerId: 'slack',
      providerAccountId,
      externalUserId: 'U-VALIDATED-INSTALLER',
      timestamp: now,
    });
    const counterparts =
      await runtime.repositories.conversations.listParticipantExternalUserIds(
        conversationId,
      );
    expect(counterparts).toEqual(['U-DIRECT-COUNTERPART']);
    await runtime.repositories.conversations.replaceConversationApprovers({
      appId,
      conversationId,
      externalUserIds: counterparts,
      updatedAt: now,
    });
    await runtime.repositories.conversations.replaceConversationApprovers({
      appId,
      conversationId: otherConversationId,
      externalUserIds: ['U-VALIDATED-INSTALLER'],
      updatedAt: now,
    });
    await expect(
      runtime.repositories.conversations.listConversationApprovers(
        conversationId,
      ),
    ).resolves.toMatchObject([{ externalUserId: 'U-DIRECT-COUNTERPART' }]);
    await expect(
      runtime.repositories.conversations.listConversationApprovers(
        otherConversationId,
      ),
    ).resolves.toMatchObject([{ externalUserId: 'U-VALIDATED-INSTALLER' }]);

    const route = fs.readFileSync(
      'apps/core/src/control/server/routes/browser-channel-accounts.ts',
      'utf8',
    );
    expect(route).toContain("conversation?.kind === 'direct'");
    expect(route).toContain('externalUserIds: directCounterparts');
    expect(route).toContain('validateControlAllowlist({');
  });

  it('correlates account conversation thread code messages and run before projection', async () => {
    const verificationId = randomUUID();
    const challenge = 'GY-4K7P';
    await runtime.service.db.insert(onboardingVerificationsPostgres).values({
      id: verificationId,
      setupId: setup.setupId,
      appId,
      agentId: setup.agentId,
      conversationId,
      providerAccountId,
      threadId,
      challenge,
      status: 'pending',
      expiresAt: '2099-09-14T00:10:00.000Z',
      createdBy: 'user:onboarding',
      updatedBy: 'user:onboarding',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.messages.saveMessage({
      id: 'message:onboarding:wrong-thread' as never,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: '1699.9' },
      direction: 'inbound',
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2099-09-14T00:00:30.000Z',
      receivedAt: '2099-09-14T00:00:30.000Z',
      parts: [{ kind: 'text', text: challenge }],
      attachments: [],
    });
    await expect(verification(verificationId)).resolves.toMatchObject({
      status: 'pending',
    });

    await runtime.repositories.messages.saveMessage({
      id: 'message:onboarding:inbound' as never,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: '1700.2' },
      direction: 'inbound',
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2099-09-14T00:01:00.000Z',
      receivedAt: '2099-09-14T00:01:00.000Z',
      parts: [{ kind: 'text', text: `@atlas ${challenge}` }],
      attachments: [],
    });
    const [config] = await runtime.service.db
      .select({ id: agentConfigVersionsPostgres.id })
      .from(agentConfigVersionsPostgres)
      .where(eq(agentConfigVersionsPostgres.agentId, setup.agentId));
    const runId = 'agent-run:onboarding:verified' as never;
    await runtime.repositories.agentRuns.saveAgentRun({
      id: runId,
      appId,
      agentId: setup.agentId as never,
      configVersionId: config!.id as never,
      conversationId,
      threadId,
      llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
      executionProviderId: 'execution-provider:test' as never,
      permissionDecisionIds: [],
      cause: 'message',
      status: 'completed',
      createdAt: '2099-09-14T00:01:30.000Z',
      startedAt: '2099-09-14T00:01:31.000Z',
      endedAt: '2099-09-14T00:01:59.000Z',
    });
    await runtime.repositories.messages.saveMessage({
      id: 'message:onboarding:outbound' as never,
      appId,
      conversationId,
      threadId,
      runId,
      externalRef: { kind: 'message', value: '1700.3' },
      direction: 'outbound',
      senderDisplayName: setup.agentName,
      trust: 'system',
      createdAt: '2099-09-14T00:02:00.000Z',
      deliveryStatus: 'sent',
      deliveredAt: '2099-09-14T00:02:01.000Z',
      replyToMessageId: '1700.2',
      parts: [{ kind: 'text', text: 'I am here.' }],
      attachments: [],
    });

    await expect(verification(verificationId)).resolves.toMatchObject({
      status: 'satisfied',
      inboundMessageId: 'message:onboarding:inbound',
      outboundMessageId: 'message:onboarding:outbound',
      onboardingRunId: runId,
      threadId,
    });
  });

  it('preserves a satisfied challenge while projection retries', async () => {
    const verificationId = randomUUID();
    const satisfiedAt = '2099-09-14T00:03:00.000Z';
    await runtime.service.db.insert(onboardingVerificationsPostgres).values({
      id: verificationId,
      setupId: setup.setupId,
      appId,
      agentId: setup.agentId,
      conversationId: otherConversationId,
      providerAccountId,
      challenge: 'GY-7P4K',
      status: 'satisfied',
      expiresAt: '2099-09-14T00:10:00.000Z',
      satisfiedAt,
      createdBy: 'user:onboarding',
      updatedBy: 'user:onboarding',
      createdAt: now,
      updatedAt: satisfiedAt,
    });
    const [row] = await runtime.service.db
      .select()
      .from(onboardingVerificationsPostgres)
      .where(eq(onboardingVerificationsPostgres.id, verificationId));
    const persistedSatisfiedAt = row!.satisfiedAt;
    await runtime.service.db
      .update(onboardingVerificationsPostgres)
      .set({
        status: 'projection_failed',
        projectionFailureCode: 'RUNTIME_PROJECTION_FAILED',
        updatedBy: 'user:onboarding',
      })
      .where(eq(onboardingVerificationsPostgres.id, row!.id));

    await expect(verification(row!.id)).resolves.toMatchObject({
      status: 'projection_failed',
      satisfiedAt: persistedSatisfiedAt,
      projectionFailureCode: 'RUNTIME_PROJECTION_FAILED',
    });
    const route = fs.readFileSync(
      'apps/core/src/control/server/routes/browser-onboarding-verification.ts',
      'utf8',
    );
    expect(route).toContain(
      "['satisfied', 'projection_failed'].includes(verification.status)",
    );
    expect(route).toContain("status: 'completed'");
    expect(route).not.toMatch(
      /status: 'projection_failed',[\s\S]{0,160}satisfiedAt: null/,
    );
  });

  function setupRequest() {
    return {
      appId,
      actorId: 'user:onboarding',
      idempotencyKey: 'onboarding-idempotency-key',
      name: 'Atlas',
      title: 'General assistant',
      responsibilities: ['Answer questions.', 'Summarise threads.'],
      modelAlias: 'sonnet',
      agentHarness: 'auto' as const,
    };
  }

  async function verification(id: string) {
    const [row] = await runtime.service.db
      .select()
      .from(onboardingVerificationsPostgres)
      .where(eq(onboardingVerificationsPostgres.id, id));
    return row;
  }
});

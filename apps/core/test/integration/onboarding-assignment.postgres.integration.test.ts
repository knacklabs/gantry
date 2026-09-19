import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OnboardingAssignmentRepository } from '@core/adapters/storage/postgres/repositories/onboarding/onboarding-assignment-repository.postgres.js';
import { PostgresOnboardingLifecycleRepository } from '@core/adapters/storage/postgres/repositories/onboarding-lifecycle-repository.postgres.js';
import { createPostgresDomainRepositories } from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import * as schema from '@core/adapters/storage/postgres/schema/schema.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type { ConversationId } from '@core/domain/conversation/conversation.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('onboarding assignment persistence', () => {
  const appId = DEFAULT_APP_ID as AppId;
  const agentId = DEFAULT_AGENT_ID as AgentId;
  const providerAccountId =
    'provider-account:onboarding-assignment' as ProviderAccountId;
  const conversationId =
    'conversation:provider-account:onboarding-assignment:C123' as ConversationId;
  const userId = 'local-console:onboarding-assignment';
  const externalUserId = 'U123';
  let schemaName: string;
  let service: PostgresStorageService;

  beforeAll(async () => {
    schemaName = `onboarding_assignment_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    const repositories = createPostgresDomainRepositories(
      service.db,
      service.pool,
    );
    const now = '2026-09-20T00:00:00.000Z';
    await repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId,
      providerId: 'slack' as ProviderId,
      externalIdentityRef: { kind: 'provider_account', value: 'T123' },
      label: 'Onboarding Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await service.db.insert(schema.onboardingDeploymentsPostgres).values({
      appId,
      userId,
      agentId,
      providerAccountId,
      currentStep: 3,
    });
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
    );
    await service.close();
  });

  it('creates a verified person, participant, approver, and install atomically', async () => {
    const repository = new OnboardingAssignmentRepository(service.db);
    const input = {
      appId,
      userId,
      agentId,
      providerAccountId,
      conversationId,
      approverExternalUserId: externalUserId,
      approverDisplayName: 'Ada Lovelace',
    };

    const first = await repository.bindWorkAssignment(input);
    const replay = await repository.bindWorkAssignment(input);

    expect(replay).toEqual(first);
    const identity = await service.pool.query<{
      display_name: string;
      verification_status: string;
    }>(
      `SELECT u.display_name, a.verification_status
         FROM users u
         JOIN user_aliases a ON a.app_id = u.app_id AND a.user_id = u.id
        WHERE a.app_id = $1 AND a.provider_account_id = $2
          AND a.external_user_id = $3`,
      [appId, providerAccountId, externalUserId],
    );
    expect(identity.rows).toEqual([
      { display_name: 'Ada Lovelace', verification_status: 'verified' },
    ]);
    const persisted = await service.pool.query<{
      participants: number;
      approvers: number;
      installs: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM conversation_participants WHERE conversation_id = $1 AND external_user_id = $2) participants,
        (SELECT count(*)::int FROM conversation_approvers WHERE conversation_id = $1 AND external_user_id = $2) approvers,
        (SELECT count(*)::int FROM conversation_installs WHERE conversation_id = $1 AND status = 'active') installs`,
      [conversationId, externalUserId],
    );
    expect(persisted.rows[0]).toEqual({
      participants: 1,
      approvers: 1,
      installs: 1,
    });
  });

  it('matches and normalizes an equivalent runtime conversation JID', async () => {
    const assignment = new OnboardingAssignmentRepository(service.db);
    await assignment.bindWorkAssignment({
      appId,
      userId,
      agentId,
      providerAccountId,
      conversationId,
      approverExternalUserId: externalUserId,
      approverDisplayName: 'Ada Lovelace',
    });
    const runtimeConversationId =
      `conversation:${providerAccountId}:sl:C123` as ConversationId;
    const repositories = createPostgresDomainRepositories(
      service.db,
      service.pool,
    );
    await repositories.conversations.saveConversation({
      id: runtimeConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    });
    await service.db.update(schema.onboardingDeploymentsPostgres).set({
      state: 'verification_required',
      desiredStateRevision: 7,
    });
    await service.db.insert(schema.settingsRevisionReceiptsPostgres).values({
      appId,
      revision: 7,
      status: 'applied',
    });
    const lifecycle = new PostgresOnboardingLifecycleRepository(service.db);
    const challenge = await lifecycle.createChallenge({
      appId,
      userId,
      challengeText: '@Atlas are you there? · ABCD1234',
    });

    const matched = await lifecycle.matchInboundChallenge({
      appId,
      agentId,
      providerAccountId,
      conversationId: runtimeConversationId,
      senderExternalUserId: externalUserId,
      content: '@Atlas are you there? · ABCD1234',
    });
    expect(matched).toEqual({
      attemptId: challenge.id,
      blocked: false,
    });
    await lifecycle.consumeInboundChallenge({
      attemptId: challenge.id,
      conversationJid: 'sl:C123',
      externalMessageId: '1712345678.000100',
      providerAccountId,
    });
    const [deployment] = await service.db
      .select({
        conversationId: schema.onboardingDeploymentsPostgres.conversationId,
      })
      .from(schema.onboardingDeploymentsPostgres);
    expect(deployment?.conversationId).toBe(runtimeConversationId);
  });
});

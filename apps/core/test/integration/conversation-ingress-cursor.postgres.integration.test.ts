import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppId } from '@core/domain/app/app.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { ConversationId } from '@core/domain/conversation/conversation.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('conversation ingress cursor Postgres repository', () => {
  let runtime: PostgresIntegrationRuntime;
  const appId = 'default' as AppId;
  const agentId = 'agent:ingress-cursor' as AgentId;
  const providerAccountId =
    'provider-account:ingress-cursor' as ProviderAccountId;
  const conversationId = 'conversation:ingress-cursor:C123' as ConversationId;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'conversation_ingress_cursor',
    });
    const now = '2026-09-20T00:00:00.000Z';
    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId,
      name: 'Cursor agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId,
      providerId: 'slack' as ProviderId,
      externalIdentityRef: { kind: 'provider_account', value: 'T123' },
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => runtime?.cleanup());

  it('advances monotonically and rejects stale workers', async () => {
    const repository = runtime.repositories.conversationIngressCursors;
    const first = await repository.advance({
      providerAccountId,
      conversationId,
      expectedVersion: 0,
      coveredThroughExternalId: '100.1',
      coveredThroughTimestamp: '2026-09-20T00:00:01.000Z',
      updatedAt: '2026-09-20T00:00:02.000Z',
    });
    expect(first).toMatchObject({ status: 'advanced', cursor: { version: 1 } });

    await expect(
      repository.advance({
        providerAccountId,
        conversationId,
        expectedVersion: 0,
        coveredThroughExternalId: '99.9',
        coveredThroughTimestamp: '2026-09-19T23:59:59.000Z',
        updatedAt: '2026-09-20T00:00:03.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'stale',
      cursor: {
        version: 1,
        coveredThroughExternalId: '100.1',
      },
    });
  });
});

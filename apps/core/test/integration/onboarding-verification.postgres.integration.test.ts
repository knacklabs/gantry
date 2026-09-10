import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';
import type { ConversationId } from '@core/domain/conversation/conversation.js';
import type { MessageId } from '@core/domain/messages/messages.js';
import type { ProviderAccountId } from '@core/domain/provider/provider.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { onboardingVerificationsPostgres } from '@core/adapters/storage/postgres/schema/schema.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const appId = DEFAULT_APP_ID;
const agentId = DEFAULT_AGENT_ID;
const providerAccountId = 'provider-account:onboarding:slack' as ProviderAccountId;
const conversationId = 'conversation:onboarding:slack:C123' as ConversationId;
const challenge = '@atlas are you there? · GY-4K7P';

maybeDescribe('onboarding verification persistence', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'onboarding_verification',
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId,
      providerId: 'slack' as never,
      externalIdentityRef: { kind: 'provider_account', value: 'T123' },
      label: 'Onboarding Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'Engineering',
      status: 'active',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('records the inbound challenge and its sent reply', async () => {
    const id = 'onboarding-verification:postgres';
    await runtime.service.db.insert(onboardingVerificationsPostgres).values({
      id,
      appId,
      agentId,
      conversationId,
      challenge,
      status: 'pending',
      expiresAt: '2026-09-10T00:10:00.000Z',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });

    const inboundId = 'message:onboarding:inbound' as MessageId;
    await runtime.repositories.messages.saveMessage({
      id: inboundId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: '1700.1' },
      direction: 'inbound',
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-09-10T00:01:00.000Z',
      receivedAt: '2026-09-10T00:01:00.000Z',
      parts: [{ kind: 'text', text: challenge }],
      attachments: [],
    });

    const outboundId = 'message:onboarding:outbound' as MessageId;
    await runtime.repositories.messages.saveMessage({
      id: outboundId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: '1700.2' },
      direction: 'outbound',
      senderDisplayName: 'Atlas',
      trust: 'system',
      createdAt: '2026-09-10T00:02:00.000Z',
      deliveryStatus: 'sent',
      deliveredAt: '2026-09-10T00:02:01.000Z',
      parts: [{ kind: 'text', text: 'I am here.' }],
      attachments: [],
    });

    const [verification] = await runtime.service.db
      .select()
      .from(onboardingVerificationsPostgres)
      .where(eq(onboardingVerificationsPostgres.id, id));
    expect(verification).toMatchObject({
      status: 'completed',
      inboundMessageId: inboundId,
      outboundMessageId: outboundId,
    });
    expect(new Date(verification!.completedAt!).toISOString()).toBe(
      '2026-09-10T00:02:01.000Z',
    );
  });
});

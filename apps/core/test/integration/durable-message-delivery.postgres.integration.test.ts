import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppId } from '@core/domain/app/app.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '@core/domain/conversation/conversation.js';
import type { MessageId } from '@core/domain/messages/messages.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const appId = DEFAULT_APP_ID as AppId;
const agentId = DEFAULT_AGENT_ID as AgentId;
const providerId = 'slack' as ProviderId;
const providerAccountId = 'provider-account:durable:slack' as ProviderAccountId;
const conversationId = 'conversation:durable:slack:C123' as ConversationId;
const secondConversationId =
  'conversation:durable:slack:C999' as ConversationId;
const threadId = 'thread:durable:slack:C123:1700.1' as ConversationThreadId;
const secondThreadId =
  'thread:durable:slack:C999:1700.2' as ConversationThreadId;
const userId = 'user:durable:U123' as UserId;
const now = '2026-04-28T00:00:00.000Z';

maybeDescribe('durable message delivery persistence', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'durable_messages',
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId,
      providerId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'T123',
      },
      label: 'Durable Slack',
      status: 'active',
      config: { workspace: 'durable' },
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
      title: 'engineering',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveThread({
      id: threadId,
      appId,
      conversationId,
      externalRef: { kind: 'conversation_thread', value: '1700.1' },
      title: 'deploy',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: secondConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C999' },
      kind: 'channel',
      title: 'incidents',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveThread({
      id: secondThreadId,
      appId,
      conversationId: secondConversationId,
      externalRef: { kind: 'conversation_thread', value: '1700.2' },
      title: 'incident-update',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('deduplicates inbound redelivery separately for root and thread scopes', async () => {
    await runtime.repositories.messages.saveMessage({
      id: 'message:durable:root:first' as MessageId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: 'evt-root' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-28T00:01:00.000Z',
      receivedAt: '2026-04-28T00:01:01.000Z',
      parts: [{ kind: 'text', text: 'root first' }],
      attachments: [],
    });
    await runtime.repositories.messages.saveMessage({
      id: 'message:durable:root:redelivery' as MessageId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: 'evt-root' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-28T00:01:00.000Z',
      receivedAt: '2026-04-28T00:01:02.000Z',
      parts: [{ kind: 'text', text: 'root redelivered' }],
      attachments: [],
    });
    await runtime.repositories.messages.saveMessage({
      id: 'message:durable:thread:first' as MessageId,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: 'evt-thread' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-28T00:02:00.000Z',
      receivedAt: '2026-04-28T00:02:01.000Z',
      parts: [{ kind: 'text', text: 'thread first' }],
      attachments: [],
    });

    const rootMessages = await runtime.repositories.messages.listMessages({
      conversationId,
      limit: 20,
    });
    const threadMessages = await runtime.repositories.messages.listMessages({
      conversationId,
      threadId,
      limit: 20,
    });

    expect(
      rootMessages.filter(
        (message) => message.externalRef?.value === 'evt-root',
      ),
    ).toHaveLength(1);
    expect(
      rootMessages.find((message) => message.externalRef?.value === 'evt-root')
        ?.parts,
    ).toEqual([{ kind: 'text', text: 'root redelivered' }]);
    expect(
      threadMessages.filter(
        (message) => message.externalRef?.value === 'evt-thread',
      ),
    ).toHaveLength(1);
  });

  it('moves outbound delivery from pending to sent and records failures without duplicate rows', async () => {
    const sentId = 'message:durable:outbound:sent' as MessageId;
    await runtime.repositories.messages.saveMessage({
      id: sentId,
      appId,
      conversationId,
      threadId,
      direction: 'outbound',
      senderDisplayName: 'Gantry',
      trust: 'system',
      createdAt: '2026-04-28T00:03:00.000Z',
      deliveryStatus: 'pending',
      parts: [{ kind: 'text', text: 'working' }],
      attachments: [],
    });
    await runtime.repositories.messages.saveMessage({
      id: sentId,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: '1710000000.200' },
      direction: 'outbound',
      senderDisplayName: 'Gantry',
      trust: 'system',
      createdAt: '2026-04-28T00:03:00.000Z',
      deliveryStatus: 'sent',
      deliveredAt: '2026-04-28T00:03:01.000Z',
      parts: [{ kind: 'text', text: 'working' }],
      attachments: [],
    });

    await expect(
      runtime.repositories.messages.getMessage(sentId),
    ).resolves.toEqual(
      expect.objectContaining({
        id: sentId,
        externalRef: { kind: 'message', value: '1710000000.200' },
        deliveryStatus: 'sent',
      }),
    );

    const failedId = 'message:durable:outbound:failed' as MessageId;
    await runtime.repositories.messages.saveMessage({
      id: failedId,
      appId,
      conversationId,
      direction: 'outbound',
      senderDisplayName: 'Gantry',
      trust: 'system',
      createdAt: '2026-04-28T00:04:00.000Z',
      deliveryStatus: 'failed',
      deliveryError: 'Slack API rejected the message',
      parts: [{ kind: 'text', text: 'failed' }],
      attachments: [],
    });
    await expect(
      runtime.repositories.messages.getMessage(failedId),
    ).resolves.toMatchObject({
      deliveryStatus: 'failed',
      deliveryError: 'Slack API rejected the message',
    });

    await runtime.repositories.messages.saveMessage({
      id: failedId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: '1710000000.201' },
      direction: 'outbound',
      senderDisplayName: 'Gantry',
      trust: 'system',
      createdAt: '2026-04-28T00:04:00.000Z',
      deliveryStatus: 'sent',
      deliveredAt: '2026-04-28T00:04:04.000Z',
      parts: [{ kind: 'text', text: 'failed' }],
      attachments: [],
    });
    await expect(
      runtime.repositories.messages.getMessage(failedId),
    ).resolves.toMatchObject({
      externalRef: { kind: 'message', value: '1710000000.201' },
      deliveryStatus: 'sent',
    });
  });

  it('does not deduplicate inbound messages across different conversations', async () => {
    await runtime.repositories.messages.saveMessage({
      id: 'message:durable:conversation-a' as MessageId,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: 'evt-cross-conversation' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-28T00:05:00.000Z',
      receivedAt: '2026-04-28T00:05:01.000Z',
      parts: [{ kind: 'text', text: 'primary conversation' }],
      attachments: [],
    });
    await runtime.repositories.messages.saveMessage({
      id: 'message:durable:conversation-b' as MessageId,
      appId,
      conversationId: secondConversationId,
      threadId: secondThreadId,
      externalRef: { kind: 'message', value: 'evt-cross-conversation' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-28T00:05:00.000Z',
      receivedAt: '2026-04-28T00:05:02.000Z',
      parts: [{ kind: 'text', text: 'secondary conversation' }],
      attachments: [],
    });

    const firstConversationMessages =
      await runtime.repositories.messages.listMessages({
        conversationId,
        threadId,
        limit: 20,
      });
    const secondConversationMessages =
      await runtime.repositories.messages.listMessages({
        conversationId: secondConversationId,
        threadId: secondThreadId,
        limit: 20,
      });

    expect(
      firstConversationMessages.filter(
        (message) =>
          message.externalRef?.value === 'evt-cross-conversation' &&
          message.threadId === threadId,
      ),
    ).toHaveLength(1);
    expect(
      secondConversationMessages.filter(
        (message) =>
          message.externalRef?.value === 'evt-cross-conversation' &&
          message.threadId === secondThreadId,
      ),
    ).toHaveLength(1);
  });
});

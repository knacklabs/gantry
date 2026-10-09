import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AppId } from '@core/domain/app/app.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '@core/domain/conversation/conversation.js';
import type {
  Message,
  MessageAttachment,
  MessageId,
} from '@core/domain/messages/messages.js';
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
const appId = DEFAULT_APP_ID as AppId;
const conversationId = 'conversation:history:pages' as ConversationId;
const threadId = 'thread:history:pages' as ConversationThreadId;
const now = '2026-10-01T00:00:00.000Z';

maybeDescribe('message history pages', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'message_history',
    });
    const providerAccountId = 'provider-account:history' as ProviderAccountId;
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId: DEFAULT_AGENT_ID as AgentId,
      providerId: 'slack' as ProviderId,
      label: 'History',
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
      kind: 'channel',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveThread({
      id: threadId,
      appId,
      conversationId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('returns hydrated earliest and latest pages chronologically with timestamp and ID ties', async () => {
    const messages: Message[] = ['a', 'b', 'c', 'd'].map((key, index) => {
      const id = `message:history:${key}` as MessageId;
      return {
        id,
        appId,
        conversationId,
        threadId: index === 0 ? undefined : threadId,
        direction: 'outbound',
        trust: 'system',
        createdAt: `2026-10-01T00:00:0${index === 2 ? 1 : index}.000Z`,
        parts: [
          { kind: 'text', text: `${key} first` },
          { kind: 'text', text: `${key} second` },
        ],
        attachments: ['a', 'z'].map((suffix) => ({
          id: `attachment:history:${key}:${suffix}` as MessageAttachment['id'],
          messageId: id,
          kind: 'file',
          contentType: 'text/plain',
          storageRef: `files/${key}/${suffix}`,
          trust: 'system',
        })),
      };
    });
    for (const message of [...messages].reverse()) {
      await runtime.repositories.messages.saveMessage({
        ...message,
        attachments: [...message.attachments].reverse(),
      });
    }

    const repository = runtime.repositories.messages;
    await expect(
      repository.listMessages({ conversationId, limit: 2 }),
    ).resolves.toEqual(messages.slice(0, 2));
    await expect(
      repository.listRecentMessages({ conversationId, limit: 2 }),
    ).resolves.toEqual(messages.slice(2));

    for (const list of [
      repository.listMessages.bind(repository),
      repository.listRecentMessages.bind(repository),
    ]) {
      await expect(
        list({ conversationId, after: messages[1].id }),
      ).resolves.toEqual(messages.slice(2));
      await expect(
        list({ conversationId, after: 'message:history:missing' }),
      ).resolves.toEqual(messages);
      await expect(list({ conversationId, limit: 0 })).resolves.toEqual([]);
      await expect(
        list({ conversationId, after: messages[3].id }),
      ).resolves.toEqual([]);
    }
    await expect(
      repository.listMessages({ conversationId, threadId, limit: 2 }),
    ).resolves.toEqual(messages.slice(1, 3));
    await expect(
      repository.listRecentMessages({ conversationId, threadId, limit: 2 }),
    ).resolves.toEqual(messages.slice(2));
  });
});

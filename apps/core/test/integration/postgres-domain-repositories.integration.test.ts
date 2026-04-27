import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresCanonicalSessionRepository } from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
  DEFAULT_PERMISSION_POLICY_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  ChannelInstallationId,
  ChannelProviderId,
} from '@core/domain/channel/channel.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '@core/domain/conversation/conversation.js';
import type {
  AgentRunEventId,
  AgentRunId,
} from '@core/domain/events/events.js';
import type { MessageId } from '@core/domain/messages/messages.js';
import type { PermissionDecisionId } from '@core/domain/permissions/permissions.js';
import type {
  AgentSessionId,
  AgentSessionSummaryId,
  ProviderSessionId,
} from '@core/domain/sessions/sessions.js';

const maybeDescribe = process.env.MYCLAW_TEST_DATABASE_URL
  ? describe
  : describe.skip;

const appId = DEFAULT_APP_ID as AppId;
const agentId = DEFAULT_AGENT_ID as AgentId;
const providerId = 'slack' as ChannelProviderId;
const installationId =
  'channel-installation:test:slack' as ChannelInstallationId;
const conversationId = 'conversation:test:slack:C123' as ConversationId;
const threadId = 'thread:test:slack:C123:1700.1' as ConversationThreadId;
const userId = 'user:test:U123' as UserId;
const now = '2026-04-27T00:00:00.000Z';

maybeDescribe('Postgres domain repositories', () => {
  let service: PostgresStorageService;
  let repositories: PostgresDomainRepositoryBundle;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `repo_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.MYCLAW_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    repositories = createPostgresDomainRepositories(service.db);

    await repositories.channelInstallations.saveChannelInstallation({
      id: installationId,
      appId,
      providerId,
      externalInstallationRef: {
        kind: 'channel_installation',
        value: 'T123',
      },
      label: 'Test Slack',
      status: 'active',
      runtimeSecretRefs: [],
      createdAt: now,
      updatedAt: now,
    });
    await repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      channelInstallationId: installationId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'engineering',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.conversations.saveThread({
      id: threadId,
      appId,
      conversationId,
      externalRef: { kind: 'conversation_thread', value: '1700.1' },
      title: 'incident',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
    );
    await service.close();
  });

  it('finds conversations and threads by provider external references', async () => {
    await expect(
      repositories.conversations.getConversationByExternalRef({
        appId,
        providerId,
        channelInstallationId: installationId,
        externalConversationId: 'C123',
      }),
    ).resolves.toMatchObject({ id: conversationId });

    await expect(
      repositories.conversations.getThreadByExternalRef({
        appId,
        providerId,
        conversationId,
        externalThreadId: '1700.1',
      }),
    ).resolves.toMatchObject({ id: threadId });
  });

  it('inserts messages idempotently by provider redelivery key', async () => {
    await repositories.messages.saveMessage({
      id: 'message:test:first' as MessageId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: 'evt-1' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-27T00:01:00.000Z',
      receivedAt: '2026-04-27T00:01:01.000Z',
      parts: [{ kind: 'text', text: 'hello' }],
      attachments: [],
    });
    await repositories.messages.saveMessage({
      id: 'message:test:redelivery' as MessageId,
      appId,
      conversationId,
      externalRef: { kind: 'message', value: 'evt-1' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-27T00:01:00.000Z',
      receivedAt: '2026-04-27T00:01:02.000Z',
      parts: [{ kind: 'text', text: 'hello redelivered' }],
      attachments: [],
    });

    const messages = await repositories.messages.listMessages({
      conversationId,
      limit: 10,
    });
    const matching = messages.filter(
      (message) => message.externalRef?.value === 'evt-1',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.id).toBe('message:test:first');
    expect(matching[0]?.parts).toEqual([
      { kind: 'text', text: 'hello redelivered' },
    ]);
  });

  it('inserts threaded messages idempotently by provider redelivery key', async () => {
    await repositories.messages.saveMessage({
      id: 'message:test:thread:first' as MessageId,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: 'evt-thread-1' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-27T00:01:10.000Z',
      receivedAt: '2026-04-27T00:01:11.000Z',
      parts: [{ kind: 'text', text: 'thread hello' }],
      attachments: [],
    });
    await repositories.messages.saveMessage({
      id: 'message:test:thread:redelivery' as MessageId,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: 'evt-thread-1' },
      direction: 'inbound',
      senderUserId: userId,
      senderDisplayName: 'Ravi',
      trust: 'trusted',
      createdAt: '2026-04-27T00:01:10.000Z',
      receivedAt: '2026-04-27T00:01:12.000Z',
      parts: [{ kind: 'text', text: 'thread redelivered' }],
      attachments: [],
    });

    const messages = await repositories.messages.listMessages({
      conversationId,
      threadId,
      limit: 10,
    });
    const matching = messages.filter(
      (message) => message.externalRef?.value === 'evt-thread-1',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.id).toBe('message:test:thread:first');
    expect(matching[0]?.parts).toEqual([
      { kind: 'text', text: 'thread redelivered' },
    ]);
  });

  it('persists outbound delivery status and provider message id', async () => {
    const outboundId = 'message:test:outbound' as MessageId;
    await repositories.messages.saveMessage({
      id: outboundId,
      appId,
      conversationId,
      threadId,
      direction: 'outbound',
      senderDisplayName: 'MyClaw',
      trust: 'system',
      createdAt: '2026-04-27T00:01:20.000Z',
      deliveryStatus: 'pending',
      parts: [{ kind: 'text', text: 'working' }],
      attachments: [],
    });
    await repositories.messages.saveMessage({
      id: outboundId,
      appId,
      conversationId,
      threadId,
      externalRef: { kind: 'message', value: '1710000000.200' },
      direction: 'outbound',
      senderDisplayName: 'MyClaw',
      trust: 'system',
      createdAt: '2026-04-27T00:01:20.000Z',
      deliveryStatus: 'sent',
      deliveredAt: '2026-04-27T00:01:21.000Z',
      parts: [{ kind: 'text', text: 'working' }],
      attachments: [],
    });

    await expect(repositories.messages.getMessage(outboundId)).resolves.toEqual(
      expect.objectContaining({
        id: outboundId,
        externalRef: { kind: 'message', value: '1710000000.200' },
        deliveryStatus: 'sent',
        deliveredAt: '2026-04-27T00:01:21.000Z',
      }),
    );
  });

  it('handles concurrent message redelivery saves with different ids', async () => {
    await Promise.all([
      repositories.messages.saveMessage({
        id: 'message:test:race:first' as MessageId,
        appId,
        conversationId,
        externalRef: { kind: 'message', value: 'evt-race' },
        direction: 'inbound',
        senderUserId: userId,
        senderDisplayName: 'Ravi',
        trust: 'trusted',
        createdAt: '2026-04-27T00:01:10.000Z',
        receivedAt: '2026-04-27T00:01:11.000Z',
        parts: [{ kind: 'text', text: 'race first' }],
        attachments: [],
      }),
      repositories.messages.saveMessage({
        id: 'message:test:race:second' as MessageId,
        appId,
        conversationId,
        externalRef: { kind: 'message', value: 'evt-race' },
        direction: 'inbound',
        senderUserId: userId,
        senderDisplayName: 'Ravi',
        trust: 'trusted',
        createdAt: '2026-04-27T00:01:10.000Z',
        receivedAt: '2026-04-27T00:01:12.000Z',
        parts: [{ kind: 'text', text: 'race second' }],
        attachments: [],
      }),
    ]);

    const messages = await repositories.messages.listMessages({
      conversationId,
      limit: 20,
    });
    expect(
      messages.filter((message) => message.externalRef?.value === 'evt-race'),
    ).toHaveLength(1);
  });

  it('looks up deterministic agent sessions and latest provider sessions', async () => {
    const sessionId = 'agent-session:test:conversation' as AgentSessionId;
    await repositories.agentSessions.saveAgentSession({
      id: sessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId,
      status: 'active',
      modelOverride: 'opus',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      repositories.agentSessions.getAgentSessionByKey({
        appId,
        agentId,
        conversationId,
        threadId,
        userId,
      }),
    ).resolves.toMatchObject({ id: sessionId, modelOverride: 'opus' });

    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:older' as ProviderSessionId,
      appId,
      agentSessionId: sessionId,
      provider: 'anthropic',
      externalSessionId: 'older',
      artifactRef: '/tmp/older.jsonl',
      providerRef: { kind: 'provider_session', value: 'anthropic:older' },
      metadata: { runtime: 'test' },
      status: 'active',
      createdAt: '2026-04-27T00:02:00.000Z',
      updatedAt: '2026-04-27T00:02:00.000Z',
    });
    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:newer' as ProviderSessionId,
      appId,
      agentSessionId: sessionId,
      provider: 'anthropic',
      externalSessionId: 'newer',
      artifactRef: '/tmp/newer.jsonl',
      providerRef: { kind: 'provider_session', value: 'anthropic:newer' },
      metadata: { runtime: 'test' },
      status: 'active',
      createdAt: '2026-04-27T00:03:00.000Z',
      updatedAt: '2026-04-27T00:03:00.000Z',
    });

    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: sessionId,
        provider: 'anthropic',
      }),
    ).resolves.toMatchObject({
      id: 'provider-session:test:newer',
      provider: 'anthropic',
      externalSessionId: 'newer',
      artifactRef: '/tmp/newer.jsonl',
      providerRef: { kind: 'provider_session', value: 'anthropic:newer' },
      metadata: { runtime: 'test' },
    });

    await repositories.agentSessionSummaries.saveAgentSessionSummary({
      id: 'agent-session-summary:test:1' as AgentSessionSummaryId,
      appId,
      agentSessionId: sessionId,
      summary: 'Prior work was summarized.',
      source: 'extractive',
      fromMessageId: 'message:test:first',
      toMessageId: 'message:test:thread:first',
      fromRunId: 'agent-run:test:old',
      toRunId: 'agent-run:test:new',
      messageCount: 2,
      runCount: 1,
      createdAt: '2026-04-27T00:04:00.000Z',
    });
    await expect(
      repositories.agentSessionSummaries.getLatestAgentSessionSummary(
        sessionId,
      ),
    ).resolves.toMatchObject({
      summary: 'Prior work was summarized.',
      source: 'extractive',
      toMessageId: 'message:test:thread:first',
    });
  });

  it('expires provider sessions by scoped row without expiring collisions', async () => {
    const firstSessionId = 'agent-session:test:expire:first' as AgentSessionId;
    const secondSessionId =
      'agent-session:test:expire:second' as AgentSessionId;
    await repositories.agentSessions.saveAgentSession({
      id: firstSessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId: 'user:test:expire:first' as UserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.agentSessions.saveAgentSession({
      id: secondSessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId: 'user:test:expire:second' as UserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:expire:first' as ProviderSessionId,
      appId,
      agentSessionId: firstSessionId,
      provider: 'anthropic',
      externalSessionId: 'shared-external-session',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:shared-external-session',
      },
      status: 'active',
      createdAt: '2026-04-27T00:04:10.000Z',
      updatedAt: '2026-04-27T00:04:10.000Z',
    });
    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:expire:second' as ProviderSessionId,
      appId,
      agentSessionId: secondSessionId,
      provider: 'anthropic',
      externalSessionId: 'shared-external-session',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:shared-external-session',
      },
      status: 'active',
      createdAt: '2026-04-27T00:04:20.000Z',
      updatedAt: '2026-04-27T00:04:20.000Z',
    });

    const canonicalSessions = new PostgresCanonicalSessionRepository(
      service.db,
    );
    await canonicalSessions.expireProviderSession({
      providerSessionId: 'provider-session:test:expire:first',
    });

    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: firstSessionId,
        provider: 'anthropic',
      }),
    ).resolves.toBeUndefined();
    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: secondSessionId,
        provider: 'anthropic',
      }),
    ).resolves.toMatchObject({
      id: 'provider-session:test:expire:second',
      externalSessionId: 'shared-external-session',
      status: 'active',
    });
  });

  it('handles concurrent deterministic agent session saves with different ids', async () => {
    await Promise.all([
      repositories.agentSessions.saveAgentSession({
        id: 'agent-session:test:race:first' as AgentSessionId,
        appId,
        agentId,
        conversationId,
        threadId,
        userId: 'user:test:race' as UserId,
        status: 'active',
        createdAt: '2026-04-27T00:03:10.000Z',
        updatedAt: '2026-04-27T00:03:10.000Z',
      }),
      repositories.agentSessions.saveAgentSession({
        id: 'agent-session:test:race:second' as AgentSessionId,
        appId,
        agentId,
        conversationId,
        threadId,
        userId: 'user:test:race' as UserId,
        status: 'active',
        modelOverride: 'sonnet',
        createdAt: '2026-04-27T00:03:10.000Z',
        updatedAt: '2026-04-27T00:03:11.000Z',
      }),
    ]);

    await expect(
      repositories.agentSessions.getAgentSessionByKey({
        appId,
        agentId,
        conversationId,
        threadId,
        userId: 'user:test:race' as UserId,
      }),
    ).resolves.toMatchObject({
      appId,
      agentId,
      conversationId,
      threadId,
      userId: 'user:test:race',
    });
  });

  it('rejects malformed provider session refs', async () => {
    await expect(
      repositories.providerSessions.saveProviderSession({
        id: 'provider-session:test:malformed' as ProviderSessionId,
        appId,
        agentSessionId: 'agent-session:test:conversation' as AgentSessionId,
        providerRef: { kind: 'provider_session', value: 'missing-provider' },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      } as never),
    ).rejects.toThrow('Provider session ref must be prefixed');
  });

  it('appends run events and reads them in cursor order', async () => {
    const runId = 'agent-run:test:1' as AgentRunId;
    await repositories.agentRuns.saveAgentRun({
      id: runId,
      appId,
      agentId,
      configVersionId: `config:${DEFAULT_AGENT_ID}:1`,
      conversationId,
      threadId,
      llmProfileId: DEFAULT_LLM_PROFILE_ID,
      permissionDecisionIds: [],
      cause: 'message',
      status: 'running',
      createdAt: '2026-04-27T00:04:00.000Z',
      startedAt: '2026-04-27T00:04:01.000Z',
    });

    await repositories.agentRuns.appendAgentRunEvent({
      id: 'agent-run-event:test:2' as AgentRunEventId,
      appId,
      runId,
      type: 'output_chunk',
      payload: { text: 'second' },
      createdAt: '2026-04-27T00:04:03.000Z',
    });
    await repositories.agentRuns.appendAgentRunEvent({
      id: 'agent-run-event:test:1' as AgentRunEventId,
      appId,
      runId,
      type: 'started',
      payload: { text: 'first' },
      createdAt: '2026-04-27T00:04:02.000Z',
    });

    await expect(
      repositories.agentRuns.listAgentRunEvents(runId),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'agent-run-event:test:1' }),
      expect.objectContaining({ id: 'agent-run-event:test:2' }),
    ]);
  });

  it('answers agent-channel binding enablement for conversations and threads', async () => {
    await repositories.channelInstallations.saveAgentChannelBinding({
      id: 'agent-channel-binding:test:conversation',
      appId,
      agentId,
      channelInstallationId: installationId,
      conversationId,
      displayName: 'Personal Agent',
      requiresTrigger: false,
      isAdminBinding: false,
      memorySubject: { kind: 'conversation', appId, conversationId },
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      repositories.channelInstallations.isAgentEnabledInConversation({
        appId,
        agentId,
        conversationId,
        threadId,
      }),
    ).resolves.toBe(true);
  });

  it('persists permission decisions with audit context', async () => {
    const decisionId = 'permission-decision:test:1' as PermissionDecisionId;
    await repositories.permissions.saveDecision({
      id: decisionId,
      appId,
      policyId: DEFAULT_PERMISSION_POLICY_ID,
      ruleIds: ['permission-rule:default:approval-required'],
      effect: 'require_approval',
      reason: 'Write operation needs approval',
      actorContext: {
        provider: 'slack',
        userId: 'U123',
      },
      actionPreview: 'write file /tmp/example',
      createdAt: '2026-04-27T00:05:00.000Z',
    });

    await expect(
      repositories.permissions.getDecision(decisionId),
    ).resolves.toMatchObject({
      id: decisionId,
      reason: 'Write operation needs approval',
      ruleIds: ['permission-rule:default:approval-required'],
      actorContext: {
        provider: 'slack',
        userId: 'U123',
      },
      actionPreview: 'write file /tmp/example',
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresCanonicalSessionRepository } from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';
import { PostgresCapabilitySecretRepository } from '@core/adapters/storage/postgres/repositories/capability-secret-repository.postgres.js';
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
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '@core/domain/conversation/conversation.js';
import type { AgentRunId } from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { MessageId } from '@core/domain/messages/messages.js';
import type { PermissionDecisionId } from '@core/domain/permissions/permissions.js';
import type {
  AgentSessionDigestId,
  AgentSessionId,
  AgentSessionSummaryId,
  ExecutionProviderId,
  ProviderSessionId,
} from '@core/domain/sessions/sessions.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;
const TEST_EXECUTION_PROVIDER_ID =
  'anthropic:claude-agent-sdk' as ExecutionProviderId;
const TEST_CODEX_PROVIDER_ID = 'codex-sdk' as ExecutionProviderId;

const appId = DEFAULT_APP_ID as AppId;
const agentId = DEFAULT_AGENT_ID as AgentId;
const providerId = 'slack' as ProviderId;
const providerAccountId =
  'channel-providerAccount:test:slack' as ProviderAccountId;
const conversationId = 'conversation:test:slack:C123' as ConversationId;
const threadId = 'thread:test:slack:C123:1700.1' as ConversationThreadId;
const userId = 'user:test:U123' as UserId;
const now = '2026-04-27T00:00:00.000Z';
const encryptionSecret = Buffer.alloc(32, 7).toString('base64');

function runtimeSecrets(): RuntimeSecretProvider {
  return {
    getSecret: ({ env }) => {
      const value = env === 'SECRET_ENCRYPTION_KEY' ? encryptionSecret : '';
      if (!value) throw new Error(`Missing ${env}`);
      return value;
    },
    getOptionalSecret: ({ env }) =>
      env === 'SECRET_ENCRYPTION_KEY' ? encryptionSecret : undefined,
  };
}

maybeDescribe('Postgres domain repositories', () => {
  let service: PostgresStorageService;
  let repositories: PostgresDomainRepositoryBundle;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `repo_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    repositories = createPostgresDomainRepositories(service.db, service.pool);

    await repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId,
      providerId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'T123',
      },
      label: 'Test Slack',
      status: 'active',
      config: { workspace: 'test' },
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId: providerAccountId,
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
        providerAccountId: providerAccountId,
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

  it('stores capability secrets encrypted and resolves metadata separately', async () => {
    const repository = new PostgresCapabilitySecretRepository(
      service.db,
      runtimeSecrets(),
    );

    const metadata = await repository.upsertSecret({
      appId,
      name: 'github_token',
      value: 'plain-token-value',
      allowedCapabilityIds: ['mcp:github'],
      actor: 'test',
      now,
    });

    expect(metadata).toMatchObject({
      appId,
      name: 'GITHUB_TOKEN',
      allowedCapabilityIds: ['mcp:github'],
      createdBy: 'test',
      updatedBy: 'test',
    });
    await expect(
      repository.getSecret({ appId, name: 'GITHUB_TOKEN' }),
    ).resolves.toMatchObject({
      name: 'GITHUB_TOKEN',
      value: 'plain-token-value',
    });
    await expect(repository.listSecrets({ appId })).resolves.toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ value: 'plain-token-value' }),
      ]),
    );

    const raw = await service.pool.query(
      'select value_encrypted from capability_secrets where app_id = $1 and name = $2',
      [appId, 'GITHUB_TOKEN'],
    );
    expect(raw.rows[0]?.value_encrypted).toContain('gcred:v2:');
    expect(raw.rows[0]?.value_encrypted).not.toContain('plain-token-value');
  });

  it('persists queued async task bursts without admission rejection', async () => {
    await repositories.asyncTasks.createTask({
      id: 'task-admission-command-1',
      appId,
      agentId,
      conversationId,
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      leaseToken: 'lease-command-1',
      fencingVersion: 1,
      now,
    });
    await repositories.asyncTasks.createTask({
      id: 'task-admission-delegated-1',
      appId,
      agentId,
      conversationId,
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      leaseToken: 'lease-delegated-1',
      fencingVersion: 1,
      now,
    });

    await repositories.asyncTasks.createTask({
      id: 'task-admission-mcp-1',
      appId,
      agentId,
      conversationId,
      kind: 'mcp_tool_call',
      status: 'queued',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      leaseToken: 'lease-mcp-1',
      fencingVersion: 1,
      now,
    });
    await repositories.asyncTasks.createTask({
      id: 'task-admission-command-2',
      appId,
      agentId,
      conversationId,
      kind: 'async_command',
      status: 'queued',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      leaseToken: 'lease-command-2',
      fencingVersion: 1,
      now,
    });
    await expect(
      repositories.asyncTasks.countTasksByStatus({ appId, agentId }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { status: 'running', count: 2 },
        { status: 'queued', count: 2 },
      ]),
    );
    await expect(
      repositories.asyncTasks.claimQueuedTask?.({
        taskId: 'task-admission-command-2',
        leaseToken: 'lease-command-2-claim',
        now,
        maxRunningPerApp: 1,
        maxRunningPerAgent: 1,
      }),
    ).resolves.toBeNull();
    await repositories.asyncTasks.transitionTask({
      taskId: 'task-admission-command-1',
      leaseToken: 'lease-command-1',
      fencingVersion: 1,
      status: 'completed',
      now,
      terminalAt: now,
    });
    const claimed = await repositories.asyncTasks.claimQueuedTask?.({
      taskId: 'task-admission-command-2',
      leaseToken: 'lease-command-2-claim',
      now,
      maxRunningPerApp: 1,
      maxRunningPerAgent: 1,
    });
    expect(claimed).toMatchObject({
      id: 'task-admission-command-2',
      status: 'running',
      leaseToken: 'lease-command-2-claim',
      fencingVersion: 2,
    });
    await expect(
      repositories.asyncTasks.transitionTask({
        taskId: 'task-admission-command-2',
        leaseToken: 'lease-command-2',
        fencingVersion: 1,
        status: 'completed',
        now,
        terminalAt: now,
      }),
    ).resolves.toBeNull();
    await repositories.asyncTasks.transitionTask({
      taskId: 'task-admission-command-2',
      leaseToken: 'lease-command-2-claim',
      fencingVersion: 2,
      status: 'completed',
      now,
      terminalAt: now,
    });
  });

  it('atomically caps async task backlog admission', async () => {
    const create = (index: number) =>
      repositories.asyncTasks.createTaskWithBacklogAdmission?.({
        task: {
          id: `task-backlog-${index}`,
          appId,
          agentId,
          conversationId,
          kind: 'async_command',
          status: 'queued',
          admissionClass: 'task',
          authoritySnapshotJson: {},
          leaseToken: `lease-backlog-${index}`,
          fencingVersion: 1,
          now,
        },
        maxBacklogPerApp: 64,
        maxBacklogPerAgent: 32,
        statuses: ['queued', 'running', 'needs_attention'],
      });

    const created = await Promise.all(
      Array.from({ length: 40 }, (_, index) => create(index)),
    );

    expect(created.filter(Boolean)).toHaveLength(32);
    await expect(
      repositories.asyncTasks.countTasksByStatus({
        appId,
        agentId,
        kind: 'async_command',
        statuses: ['queued'],
      }),
    ).resolves.toEqual([{ status: 'queued', count: 32 }]);
  });

  it('deduplicates scoped session compaction admission and times out stale running tasks', async () => {
    const first = await repositories.asyncTasks.createTaskWithScopedAdmission?.(
      {
        task: {
          id: 'task-session-compact-1',
          appId,
          agentId,
          conversationId,
          threadId,
          kind: 'session_compaction',
          status: 'queued',
          admissionClass: 'task',
          authoritySnapshotJson: { internal: true },
          privateCorrelationJson: {},
          leaseToken: 'lease-session-compact-1',
          fencingVersion: 1,
          now,
        },
        activeStatuses: ['queued', 'running'],
      },
    );
    expect(first).toMatchObject({
      admitted: true,
      task: { id: 'task-session-compact-1' },
      staleTasks: [],
    });

    const duplicate =
      await repositories.asyncTasks.createTaskWithScopedAdmission?.({
        task: {
          id: 'task-session-compact-2',
          appId,
          agentId,
          conversationId,
          threadId,
          kind: 'session_compaction',
          status: 'queued',
          admissionClass: 'task',
          authoritySnapshotJson: { internal: true },
          privateCorrelationJson: {},
          leaseToken: 'lease-session-compact-2',
          fencingVersion: 1,
          now,
        },
        activeStatuses: ['queued', 'running'],
      });
    expect(duplicate).toMatchObject({
      admitted: false,
      task: { id: 'task-session-compact-1' },
      staleTasks: [],
    });

    const afterQueuedTimeout =
      await repositories.asyncTasks.createTaskWithScopedAdmission?.({
        task: {
          id: 'task-session-compact-queued-timeout',
          appId,
          agentId,
          conversationId,
          threadId,
          kind: 'session_compaction',
          status: 'queued',
          admissionClass: 'task',
          authoritySnapshotJson: { internal: true },
          privateCorrelationJson: {},
          leaseToken: 'lease-session-compact-queued-timeout',
          fencingVersion: 1,
          now: '2026-04-27T00:12:00.000Z',
        },
        activeStatuses: ['queued', 'running'],
        staleRunningBefore: '2026-04-27T00:11:00.000Z',
        staleRunningStatus: 'timed_out',
        staleErrorSummary: 'Session compaction exceeded the 10 minute timeout.',
      });
    expect(afterQueuedTimeout).toMatchObject({
      admitted: true,
      task: { id: 'task-session-compact-queued-timeout' },
      staleTasks: [{ id: 'task-session-compact-1', status: 'timed_out' }],
    });

    await repositories.asyncTasks.transitionTask({
      taskId: 'task-session-compact-queued-timeout',
      leaseToken: 'lease-session-compact-queued-timeout',
      fencingVersion: 1,
      status: 'running',
      now: '2026-04-27T00:01:00.000Z',
      startedAt: '2026-04-27T00:01:00.000Z',
      heartbeatAt: '2026-04-27T00:01:00.000Z',
    });
    const afterTimeout =
      await repositories.asyncTasks.createTaskWithScopedAdmission?.({
        task: {
          id: 'task-session-compact-3',
          appId,
          agentId,
          conversationId,
          threadId,
          kind: 'session_compaction',
          status: 'queued',
          admissionClass: 'task',
          authoritySnapshotJson: { internal: true },
          privateCorrelationJson: {},
          leaseToken: 'lease-session-compact-3',
          fencingVersion: 1,
          now: '2026-04-27T00:12:00.000Z',
        },
        activeStatuses: ['queued', 'running'],
        staleRunningBefore: '2026-04-27T00:11:00.000Z',
        staleRunningStatus: 'timed_out',
        staleErrorSummary: 'Session compaction exceeded the 10 minute timeout.',
      });
    expect(afterTimeout).toMatchObject({
      admitted: true,
      task: { id: 'task-session-compact-3' },
      staleTasks: [
        { id: 'task-session-compact-queued-timeout', status: 'timed_out' },
      ],
    });
  });

  it('rebinds desired-state conversation and binding upserts to the selected provider connection', async () => {
    const selectedConnectionId =
      'channel-providerAccount:test:slack-selected' as ProviderAccountId;
    const reboundConversationId =
      'conversation:test:slack:C999' as ConversationId;
    const bindingId = 'agent-channel-binding:test:rebound';
    await repositories.providerAccounts.saveProviderAccount({
      id: selectedConnectionId,
      appId,
      agentId,
      providerId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'T999',
      },
      label: 'Selected Slack',
      status: 'active',
      config: { workspace: 'selected' },
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: now,
      updatedAt: now,
    });

    await repositories.conversations.saveConversation({
      id: reboundConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C999' },
      kind: 'channel',
      title: 'stale',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.providerAccounts.saveConversationInstall({
      id: bindingId,
      appId,
      agentId,
      providerAccountId,
      conversationId: reboundConversationId,
      displayName: 'stale',
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId,
        conversationId: reboundConversationId,
      },
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
      createdAt: now,
      updatedAt: now,
    });

    await repositories.conversations.saveConversation({
      id: reboundConversationId,
      appId,
      providerAccountId: selectedConnectionId,
      externalRef: { kind: 'conversation', value: 'C999' },
      kind: 'channel',
      title: 'selected',
      status: 'active',
      createdAt: now,
      updatedAt: '2026-04-27T00:01:00.000Z',
    });
    await repositories.providerAccounts.saveConversationInstall({
      id: bindingId,
      appId,
      agentId,
      providerAccountId: selectedConnectionId,
      conversationId: reboundConversationId,
      displayName: 'selected',
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId,
        conversationId: reboundConversationId,
      },
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
      createdAt: now,
      updatedAt: '2026-04-27T00:01:00.000Z',
    });

    await expect(
      repositories.conversations.getConversation(reboundConversationId),
    ).resolves.toMatchObject({
      providerAccountId: selectedConnectionId,
      title: 'selected',
    });
    await expect(
      repositories.providerAccounts.getConversationInstall({
        appId,
        agentId,
        conversationId: reboundConversationId,
      }),
    ).resolves.toMatchObject({
      providerAccountId: selectedConnectionId,
      displayName: 'selected',
    });
  });

  it('partially updates provider connections without clobbering stored config', async () => {
    const partialInstallationId =
      'channel-providerAccount:test:partial' as ProviderAccountId;
    await repositories.providerAccounts.saveProviderAccount({
      id: partialInstallationId,
      appId,
      agentId,
      providerId,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'T-PARTIAL',
      },
      label: 'Partial Slack',
      status: 'active',
      config: { workspace: 'partial', locale: 'en' },
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      repositories.providerAccounts.updateProviderAccount({
        appId,
        id: partialInstallationId,
        patch: { label: 'Renamed Slack' },
        updatedAt: '2026-04-27T00:00:10.000Z',
      }),
    ).resolves.toMatchObject({
      label: 'Renamed Slack',
      config: { workspace: 'partial', locale: 'en' },
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
    });
  });

  it('disables omitted agent capability bindings during replacement', async () => {
    const updatedAt = '2026-05-02T00:00:00.000Z';

    await repositories.agents.replaceAgentCapabilityBindings({
      appId,
      agentId,
      toolBindings: [
        {
          id: `agent-tool-binding:${agentId}:tool:Browser` as never,
          appId,
          agentId,
          toolId: 'tool:Browser' as never,
          status: 'active',
          createdAt: updatedAt,
          updatedAt,
        },
        {
          id: `agent-tool-binding:${agentId}:tool:mcp__gantry__service_restart` as never,
          appId,
          agentId,
          toolId: 'tool:mcp__gantry__service_restart' as never,
          status: 'active',
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      skillBindings: [],
      mcpBindings: [],
      updatedAt,
    });

    const bindings = await repositories.tools.listAgentToolBindings({
      appId,
      agentId,
    });

    expect(
      bindings.find((binding) => binding.toolId === 'tool:Browser')?.status,
    ).toBe('active');
    expect(
      bindings.find(
        (binding) => binding.toolId === 'tool:mcp__gantry__service_restart',
      )?.status,
    ).toBe('active');

    await repositories.agents.replaceAgentCapabilityBindings({
      appId,
      agentId,
      toolBindings: [
        {
          id: `agent-tool-binding:${agentId}:tool:Browser` as never,
          appId,
          agentId,
          toolId: 'tool:Browser' as never,
          status: 'active',
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      skillBindings: [],
      mcpBindings: [],
      updatedAt,
    });

    const replacedBindings = await repositories.tools.listAgentToolBindings({
      appId,
      agentId,
    });

    expect(
      replacedBindings.find((binding) => binding.toolId === 'tool:Browser')
        ?.status,
    ).toBe('active');
    expect(
      replacedBindings.find(
        (binding) => binding.toolId === 'tool:mcp__gantry__service_restart',
      )?.status,
    ).toBe('disabled');
  });

  it('stores source-only tool attachments separately from capability bindings', async () => {
    const updatedAt = '2026-05-02T00:00:00.000Z';

    await repositories.agents.replaceAgentCapabilityBindings({
      appId,
      agentId,
      toolBindings: [],
      skillBindings: [],
      mcpBindings: [],
      updatedAt,
    });

    await repositories.tools.replaceAgentToolSources?.({
      appId,
      agentId,
      sources: [
        {
          id: `agent-tool-source:${agentId}:builtin:browser:builtin` as never,
          appId,
          agentId,
          sourceId: 'browser',
          kind: 'builtin',
          version: 'builtin',
          status: 'active',
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      updatedAt,
    });

    const sources = await repositories.tools.listAgentToolSources?.({
      appId,
      agentId,
    });
    const bindings = await repositories.tools.listAgentToolBindings({
      appId,
      agentId,
    });

    expect(sources).toEqual([
      expect.objectContaining({
        sourceId: 'browser',
        kind: 'builtin',
        version: 'builtin',
        status: 'active',
      }),
    ]);
    expect(bindings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolId: 'tool:Browser', status: 'active' }),
      ]),
    );
  });

  it('replaces agent access bindings and tool sources in one repository call', async () => {
    const updatedAt = '2026-05-02T00:01:00.000Z';
    const mcpServerId = 'mcp:repo-test' as never;

    await repositories.mcpServers.saveServer({
      id: mcpServerId,
      appId,
      name: 'repo-test',
      status: 'active',
      createdSource: 'admin',
      riskClass: 'medium',
      transport: 'stdio_template',
      config: { transport: 'stdio_template', templateId: 'node-script' },
      allowedToolPatterns: ['read_*', 'write_*'],
      autoApproveToolPatterns: [],
      credentialRefs: [],
      networkHosts: [],
      createdAt: updatedAt,
      updatedAt,
    });

    await repositories.agents.replaceAgentAccess({
      appId,
      agentId,
      toolBindings: [
        {
          id: `agent-tool-binding:${agentId}:tool:Browser` as never,
          appId,
          agentId,
          toolId: 'tool:Browser' as never,
          status: 'active',
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      skillBindings: [],
      mcpBindings: [
        {
          id: `agent-mcp-binding:${agentId}:${mcpServerId}` as never,
          appId,
          agentId,
          serverId: mcpServerId,
          status: 'active',
          required: false,
          permissionPolicyIds: [],
          allowedToolPatterns: ['read_*'],
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      toolSources: [
        {
          id: `agent-tool-source:${agentId}:builtin:browser:builtin` as never,
          appId,
          agentId,
          sourceId: 'browser',
          kind: 'builtin',
          version: 'builtin',
          status: 'active',
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      updatedAt,
    });

    await expect(
      repositories.tools.listAgentToolBindings({ appId, agentId }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolId: 'tool:Browser', status: 'active' }),
      ]),
    );
    await expect(
      repositories.tools.listAgentToolSources?.({ appId, agentId }),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceId: 'browser',
        kind: 'builtin',
        status: 'active',
      }),
    ]);
    await expect(
      repositories.mcpServers.listAgentBindings({ appId, agentId }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: mcpServerId,
          allowedToolPatterns: ['read_*'],
        }),
      ]),
    );
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
      senderDisplayName: 'Gantry',
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
      senderDisplayName: 'Gantry',
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
      model: 'opus',
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
    ).resolves.toMatchObject({ id: sessionId, model: 'opus' });

    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:older' as ProviderSessionId,
      appId,
      agentSessionId: sessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'older',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:older',
      },
      metadata: { runtime: 'test' },
      status: 'active',
      createdAt: '2026-04-27T00:02:00.000Z',
      updatedAt: '2026-04-27T00:02:00.000Z',
    });
    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:newer' as ProviderSessionId,
      appId,
      agentSessionId: sessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'newer',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:newer',
      },
      metadata: { runtime: 'test' },
      status: 'active',
      createdAt: '2026-04-27T00:03:00.000Z',
      updatedAt: '2026-04-27T00:03:00.000Z',
    });

    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: sessionId,
        provider: TEST_EXECUTION_PROVIDER_ID,
      }),
    ).resolves.toMatchObject({
      id: 'provider-session:test:newer',
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'newer',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:newer',
      },
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

  it('filters digests by persisted scope fields before limiting rows', async () => {
    const sessionId = 'agent-session:test:digest-scope' as AgentSessionId;
    const digestScopeUserId = 'user:test:digest-scope' as UserId;
    await repositories.agentSessions.saveAgentSession({
      id: sessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId: digestScopeUserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    for (let index = 0; index < 250; index += 1) {
      await repositories.agentSessionDigests.saveAgentSessionDigest({
        id: `agent-session-digest:test:wrong:${index}` as AgentSessionDigestId,
        appId,
        agentSessionId: sessionId,
        trigger: 'session-end',
        digest: `wrong-scope-${index}`,
        messageCount: 1,
        extractedFactCount: 0,
        metadata: {
          sessionScope: {
            appId,
            agentId,
            conversationId: 'conversation:test:slack:C999',
            userId: digestScopeUserId,
            threadId,
          },
        },
        createdAt: `2026-04-27T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      });
    }
    await repositories.agentSessionDigests.saveAgentSessionDigest({
      id: 'agent-session-digest:test:older-match' as AgentSessionDigestId,
      appId,
      agentSessionId: sessionId,
      trigger: 'session-end',
      digest: 'matching-scope-digest',
      messageCount: 2,
      extractedFactCount: 0,
      metadata: {
        sessionScope: {
          appId,
          agentId,
          conversationId,
          userId: digestScopeUserId,
          threadId,
        },
      },
      createdAt: '2026-04-26T23:59:59.000Z',
    });

    const scoped =
      await repositories.agentSessionDigests.listAgentSessionDigests({
        agentSessionId: sessionId,
        sessionScope: {
          appId,
          agentId,
          conversationId,
          userId: digestScopeUserId,
          threadId,
        },
        limit: 1,
      });

    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.id).toBe('agent-session-digest:test:older-match');
    expect(scoped[0]?.digest).toBe('matching-scope-digest');
  });

  it('prevents provider-session ownership reassignment across agent sessions', async () => {
    const ownerSessionId =
      'agent-session:test:provider-owner' as AgentSessionId;
    const otherSessionId =
      'agent-session:test:provider-other' as AgentSessionId;
    const providerSessionId =
      'provider-session:test:ownership-guard' as ProviderSessionId;
    await repositories.agentSessions.saveAgentSession({
      id: ownerSessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId: 'user:test:provider-owner' as UserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.agentSessions.saveAgentSession({
      id: otherSessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId: 'user:test:provider-other' as UserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await repositories.providerSessions.saveProviderSession({
      id: providerSessionId,
      appId,
      agentSessionId: ownerSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'ownership-guard-v1',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:ownership-guard-v1',
      },
      status: 'active',
      createdAt: '2026-04-27T00:04:00.000Z',
      updatedAt: '2026-04-27T00:04:00.000Z',
    });

    await expect(
      repositories.providerSessions.saveProviderSession({
        id: providerSessionId,
        appId,
        agentSessionId: otherSessionId,
        provider: TEST_EXECUTION_PROVIDER_ID,
        externalSessionId: 'ownership-guard-v2',
        providerRef: {
          kind: 'provider_session',
          value: 'anthropic:claude-agent-sdk:ownership-guard-v2',
        },
        status: 'active',
        createdAt: '2026-04-27T00:04:10.000Z',
        updatedAt: '2026-04-27T00:04:10.000Z',
      }),
    ).rejects.toThrow(/already owned by another session/);

    await expect(
      repositories.providerSessions.getProviderSession(providerSessionId),
    ).resolves.toMatchObject({
      id: providerSessionId,
      agentSessionId: ownerSessionId,
      externalSessionId: 'ownership-guard-v1',
      status: 'active',
    });
    await expect(
      repositories.agentSessions.getAgentSession(otherSessionId),
    ).resolves.not.toMatchObject({
      latestProviderSessionId: providerSessionId,
    });
  });

  it('prevents provider-session ownership reassignment across provider/external identities', async () => {
    const ownerSessionId =
      'agent-session:test:provider-owner-identity' as AgentSessionId;
    const providerSessionId =
      'provider-session:test:ownership-identity-guard' as ProviderSessionId;
    await repositories.agentSessions.saveAgentSession({
      id: ownerSessionId,
      appId,
      agentId,
      conversationId,
      threadId,
      userId: 'user:test:provider-owner-identity' as UserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await repositories.providerSessions.saveProviderSession({
      id: providerSessionId,
      appId,
      agentSessionId: ownerSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'ownership-identity-v1',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:ownership-identity-v1',
      },
      status: 'active',
      createdAt: '2026-04-27T00:04:00.000Z',
      updatedAt: '2026-04-27T00:04:00.000Z',
    });

    await expect(
      repositories.providerSessions.saveProviderSession({
        id: providerSessionId,
        appId,
        agentSessionId: ownerSessionId,
        provider: 'openai',
        externalSessionId: 'ownership-identity-v1',
        providerRef: {
          kind: 'provider_session',
          value: 'openai:ownership-identity-v1',
        },
        status: 'active',
        createdAt: '2026-04-27T00:04:10.000Z',
        updatedAt: '2026-04-27T00:04:10.000Z',
      }),
    ).rejects.toThrow(/already owned by another session/);

    await expect(
      repositories.providerSessions.saveProviderSession({
        id: providerSessionId,
        appId,
        agentSessionId: ownerSessionId,
        provider: TEST_EXECUTION_PROVIDER_ID,
        externalSessionId: 'ownership-identity-v2',
        providerRef: {
          kind: 'provider_session',
          value: 'anthropic:claude-agent-sdk:ownership-identity-v2',
        },
        status: 'active',
        createdAt: '2026-04-27T00:04:20.000Z',
        updatedAt: '2026-04-27T00:04:20.000Z',
      }),
    ).rejects.toThrow(/already owned by another session/);

    await expect(
      repositories.providerSessions.getProviderSession(providerSessionId),
    ).resolves.toMatchObject({
      id: providerSessionId,
      appId,
      agentSessionId: ownerSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'ownership-identity-v1',
      status: 'active',
    });
  });

  it('requires full ownership predicates before expiring provider sessions', async () => {
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
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'shared-external-session',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:shared-external-session',
      },
      status: 'active',
      createdAt: '2026-04-27T00:04:10.000Z',
      updatedAt: '2026-04-27T00:04:10.000Z',
    });
    await repositories.providerSessions.saveProviderSession({
      id: 'provider-session:test:expire:second' as ProviderSessionId,
      appId,
      agentSessionId: secondSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'shared-external-session',
      providerRef: {
        kind: 'provider_session',
        value: 'anthropic:claude-agent-sdk:shared-external-session',
      },
      status: 'active',
      createdAt: '2026-04-27T00:04:20.000Z',
      updatedAt: '2026-04-27T00:04:20.000Z',
    });

    const canonicalSessions = new PostgresCanonicalSessionRepository(
      service.db,
    );
    const firstProviderSessionId = 'provider-session:test:expire:first';
    await canonicalSessions.expireProviderSession({
      providerSessionId: firstProviderSessionId,
      agentSessionId: '',
      provider: '',
      externalSessionId: '',
    });

    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: firstSessionId,
        provider: TEST_EXECUTION_PROVIDER_ID,
      }),
    ).resolves.toMatchObject({
      id: firstProviderSessionId,
      externalSessionId: 'shared-external-session',
      status: 'active',
    });
    await canonicalSessions.expireProviderSession({
      providerSessionId: firstProviderSessionId,
      agentSessionId: firstSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: 'shared-external-session',
    });
    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: firstSessionId,
        provider: TEST_EXECUTION_PROVIDER_ID,
      }),
    ).resolves.toBeNull();
    await expect(
      repositories.providerSessions.getLatestProviderSession({
        agentSessionId: secondSessionId,
        provider: TEST_EXECUTION_PROVIDER_ID,
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
        model: 'sonnet',
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
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      providerRunId: 'provider-run:test:1',
      providerSessionId: 'provider-session:test:run:1' as ProviderSessionId,
      workerId: 'worker:test:1',
      leaseOwner: 'lease-owner:test:1',
      leaseExpiresAt: '2026-04-27T00:05:00.000Z',
      permissionDecisionIds: [],
      cause: 'message',
      status: 'running',
      createdAt: '2026-04-27T00:04:00.000Z',
      startedAt: '2026-04-27T00:04:01.000Z',
    });

    await expect(
      repositories.agentRuns.getAgentRun(runId),
    ).resolves.toMatchObject({
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      providerRunId: 'provider-run:test:1',
      providerSessionId: 'provider-session:test:run:1',
      workerId: 'worker:test:1',
      leaseOwner: 'lease-owner:test:1',
      leaseExpiresAt: '2026-04-27T00:05:00.000Z',
    });

    await repositories.runtimeEvents.appendRuntimeEvent({
      appId,
      runId,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING,
      actor: 'runtime',
      payload: { text: 'second' },
      createdAt: '2026-04-27T00:04:03.000Z',
    });
    await repositories.runtimeEvents.appendRuntimeEvent({
      appId,
      runId,
      eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
      actor: 'runtime',
      payload: { text: 'first' },
      createdAt: '2026-04-27T00:04:02.000Z',
    });

    await expect(
      repositories.runtimeEvents.listRuntimeEvents({ appId, runId }),
    ).resolves.toEqual([
      expect.objectContaining({ payload: { text: 'second' } }),
      expect.objectContaining({ payload: { text: 'first' } }),
    ]);
  });

  it('answers agent conversation binding enablement for conversations and threads', async () => {
    await repositories.providerAccounts.saveConversationInstall({
      id: 'agent-channel-binding:test:conversation',
      appId,
      agentId,
      providerAccountId: providerAccountId,
      conversationId,
      displayName: 'Default Agent',
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: 'conversation',
      memorySubject: { kind: 'conversation', appId, conversationId },
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      repositories.providerAccounts.isAgentEnabledInConversation({
        appId,
        agentId,
        conversationId,
        threadId,
      }),
    ).resolves.toBe(true);

    await repositories.providerAccounts.disableConversationInstall({
      appId,
      agentId,
      conversationId,
      updatedAt: '2026-04-27T00:06:00.000Z',
    });

    await expect(
      repositories.providerAccounts.isAgentEnabledInConversation({
        appId,
        agentId,
        conversationId,
      }),
    ).resolves.toBe(false);

    await expect(
      repositories.providerAccounts.getConversationInstall({
        appId,
        agentId,
        conversationId,
      }),
    ).resolves.toMatchObject({
      displayName: 'Default Agent',
      status: 'disabled',
      senderPolicy: 'provider_native',
      memoryScope: 'conversation',
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
    });
  });

  it('keeps exact thread install lookup from matching whole-conversation installs', async () => {
    const exactConversationId =
      'conversation:test:slack:C-thread-exact' as ConversationId;
    const exactThreadId =
      'thread:test:slack:C-thread-exact:1700.1' as ConversationThreadId;

    await repositories.conversations.saveConversation({
      id: exactConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C-thread-exact' },
      kind: 'channel',
      title: 'thread exact',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.conversations.saveThread({
      id: exactThreadId,
      appId,
      conversationId: exactConversationId,
      externalRef: { kind: 'conversation_thread', value: '1700.1' },
      title: 'thread exact',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.providerAccounts.saveConversationInstall({
      id: 'agent-channel-binding:test:thread-exact:conversation',
      appId,
      agentId,
      providerAccountId,
      conversationId: exactConversationId,
      displayName: 'Whole conversation',
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId,
        conversationId: exactConversationId,
      },
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      repositories.providerAccounts.getConversationInstall({
        appId,
        agentId,
        conversationId: exactConversationId,
        threadId: exactThreadId,
        exactThreadId: true,
      }),
    ).resolves.toBeNull();

    await repositories.providerAccounts.saveConversationInstall({
      id: 'agent-channel-binding:test:thread-exact:thread',
      appId,
      agentId,
      providerAccountId,
      conversationId: exactConversationId,
      threadId: exactThreadId,
      displayName: 'Thread',
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId,
        conversationId: exactConversationId,
      },
      permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      repositories.providerAccounts.listConversationInstallsByConversation({
        appId,
        conversationId: exactConversationId,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-channel-binding:test:thread-exact:conversation',
          threadId: undefined,
        }),
        expect.objectContaining({
          id: 'agent-channel-binding:test:thread-exact:thread',
          threadId: exactThreadId,
        }),
      ]),
    );
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

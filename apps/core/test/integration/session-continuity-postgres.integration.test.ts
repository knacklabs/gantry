import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentRunId } from '@core/domain/events/events.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type {
  ExecutionProviderId,
  ProviderSessionId,
} from '@core/domain/sessions/sessions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const now = '2026-04-28T00:00:00.000Z';
const TEST_EXECUTION_PROVIDER_ID =
  'anthropic:claude-agent-sdk' as ExecutionProviderId;
const TEST_CODEX_PROVIDER_ID = 'codex:agent-sdk' as ExecutionProviderId;

function makeContinuityJob(
  id: string,
  patch: Partial<JobUpsertInput> = {},
): JobUpsertInput {
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Summarize current status',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    execution_context: {
      conversationJid: 'app:shared:conversation',
      threadId: null,
      workspaceKey: 'shared_agent',
      sessionId: null,
    },
    notification_routes: [
      {
        conversationJid: 'app:shared:conversation',
        threadId: null,
        label: 'primary',
      },
    ],
    workspace_key: 'shared_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    ...patch,
  };
}

maybeDescribe('Postgres memory continuity', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'session_continuity',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('returns canonical Gantry turn context when provider session metadata exists', async () => {
    const workspaceFolder = 'group-session-mode';
    const chatJid = 'tg:group-session-mode';
    const sessionId = 'provider-session:test:mode';

    await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });

    const withoutArtifact = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    expect(withoutArtifact).toMatchObject({
      appId: expect.any(String),
      agentId: expect.any(String),
      agentSessionId: expect.any(String),
    });

    await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });

    const withArtifact = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    expect(withArtifact.agentSessionId).toBe(withoutArtifact.agentSessionId);
    expect(withArtifact).toMatchObject({
      providerSessionId: sessionId,
      externalSessionId: sessionId,
    });
  });

  it('uses active conversation binding agent identity for turn context', async () => {
    const chatJid = 'tg:bound-skill-agent';

    await runtime.ops.setConversationRoute(chatJid, {
      name: 'Bound Skill Agent',
      folder: 'bound_skill_agent',
      trigger: '@Andy',
      added_at: '2026-04-28T00:00:00.000Z',
      requiresTrigger: false,
    });

    const context = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: 'runtime_workspace_folder',
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    expect(context).toMatchObject({
      appId: 'default',
      agentId: 'agent:bound_skill_agent',
      agentSessionId: expect.stringContaining(
        'agent:agent%3Abound_skill_agent::',
      ),
    });
  });

  it('does not reuse provider sessions when a conversation route rebinds to another agent', async () => {
    const chatJid = 'tg:session-rebind';
    const routeFolder = 'runtime_workspace_folder';

    await runtime.ops.setConversationRoute(chatJid, {
      name: 'Agent A',
      folder: 'agent_a',
      trigger: '@A',
      added_at: '2026-05-08T00:00:00.000Z',
      requiresTrigger: false,
    });
    await runtime.sessionOps.setSession(
      routeFolder,
      'provider-session:test:agent-a',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );
    const agentAContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: routeFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    await runtime.ops.setConversationRoute(chatJid, {
      name: 'Agent B',
      folder: 'agent_b',
      trigger: '@B',
      added_at: '2026-05-08T00:01:00.000Z',
      requiresTrigger: false,
    });
    const agentBContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: routeFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    expect(agentAContext).toMatchObject({
      agentId: 'agent:agent_a',
      externalSessionId: 'provider-session:test:agent-a',
    });
    expect(agentBContext).toMatchObject({
      agentId: 'agent:agent_b',
    });
    expect(agentBContext.agentSessionId).not.toBe(agentAContext.agentSessionId);
    expect(agentBContext).not.toHaveProperty('providerSessionId');
    expect(agentBContext).not.toHaveProperty('externalSessionId');

    await runtime.sessionOps.setSession(
      routeFolder,
      'provider-session:test:agent-b',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );
    await expect(
      runtime.sessionOps.getAgentTurnContext({
        workspaceFolder: routeFolder,
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
        threadId: null,
      }),
    ).resolves.toMatchObject({
      agentId: 'agent:agent_b',
      agentSessionId: agentBContext.agentSessionId,
      externalSessionId: 'provider-session:test:agent-b',
    });
  });

  it('keeps app-scoped provider sessions isolated for the same agent and route', async () => {
    const workspaceFolder = 'app-scoped-shared-agent';
    const chatJid = 'app:shared:conversation';
    const externalConversationId = 'shared-conversation';

    await runtime.control.ensureAppSession({
      appId: 'app:one',
      conversationId: externalConversationId,
      chatJid,
      workspaceFolder,
    });
    await runtime.control.ensureAppSession({
      appId: 'app:two',
      conversationId: externalConversationId,
      chatJid,
      workspaceFolder,
    });

    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:app-one',
      null,
      {
        appId: 'app:one',
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );
    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:app-two',
      null,
      {
        appId: 'app:two',
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );

    const appOneContext = await runtime.sessionOps.getAgentTurnContext({
      appId: 'app:one',
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    const appTwoContext = await runtime.sessionOps.getAgentTurnContext({
      appId: 'app:two',
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    expect(appOneContext).toMatchObject({
      appId: 'app:one',
      agentId: `agent:${workspaceFolder}`,
      externalSessionId: 'provider-session:test:app-one',
    });
    expect(appTwoContext).toMatchObject({
      appId: 'app:two',
      agentId: `agent:${workspaceFolder}`,
      externalSessionId: 'provider-session:test:app-two',
    });
    expect(appOneContext.agentSessionId).not.toBe(appTwoContext.agentSessionId);
  });

  it('scoped reset clears only the targeted agent owner session state', async () => {
    const chatJid = 'tg:session-reset-owner';
    const routeFolder = 'runtime_workspace_folder';
    const sessionA = 'provider-session:test:reset-owner:agent-a';
    const sessionB = 'provider-session:test:reset-owner:agent-b';

    await runtime.ops.setConversationRoute(chatJid, {
      name: 'Reset Owner Agent A',
      folder: 'reset_owner_agent_a',
      trigger: '@A',
      added_at: '2026-05-08T00:00:00.000Z',
      requiresTrigger: false,
    });
    await runtime.sessionOps.setSession(routeFolder, sessionA, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });
    const agentAContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: routeFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    await runtime.ops.setConversationRoute(chatJid, {
      name: 'Reset Owner Agent B',
      folder: 'reset_owner_agent_b',
      trigger: '@B',
      added_at: '2026-05-08T00:01:00.000Z',
      requiresTrigger: false,
    });
    await runtime.sessionOps.setSession(routeFolder, sessionB, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });
    const agentBContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: routeFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    expect(agentBContext.agentSessionId).not.toBe(agentAContext.agentSessionId);

    await runtime.sessionOps.deleteSession(routeFolder, null, {
      chatJid,
      agentId: agentBContext.agentId,
    });

    await expect(
      runtime.sessionOps.getAgentTurnContext({
        workspaceFolder: routeFolder,
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
        threadId: null,
      }),
    ).resolves.not.toHaveProperty('providerSessionId');

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        sessionA as ProviderSessionId,
      ),
    ).resolves.toMatchObject({
      status: 'active',
      agentSessionId: agentAContext.agentSessionId,
      externalSessionId: sessionA,
    });
  });

  it('replaces provider session per scope without clobbering a thread scope', async () => {
    const workspaceFolder = 'group-session-replacement';
    const chatJid = 'tg:group-session-replacement';
    const threadId = 'thread-1';

    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:root:v1',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );
    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:thread:v1',
      threadId,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );
    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:root:v2',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );

    const rootResume = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    const threadResume = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId,
    });

    expect(rootResume.agentSessionId).not.toBe(threadResume.agentSessionId);
    expect(rootResume).toMatchObject({
      externalSessionId: 'provider-session:test:root:v2',
    });
    expect(threadResume).toMatchObject({
      externalSessionId: 'provider-session:test:thread:v1',
    });

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:root:v1' as ProviderSessionId,
      ),
    ).resolves.toBeNull();
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:root:v2' as ProviderSessionId,
      ),
    ).resolves.toMatchObject({ status: 'active' });
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:thread:v1' as ProviderSessionId,
      ),
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('replaces one execution provider session without clobbering another provider', async () => {
    const workspaceFolder = 'provider-neutral-session';
    const chatJid = 'tg:provider-neutral-session';

    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:anthropic:v1',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );
    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:codex:v1',
      null,
      {
        executionProviderId: TEST_CODEX_PROVIDER_ID,
        chatJid,
      },
    );
    await runtime.sessionOps.setSession(
      workspaceFolder,
      'provider-session:test:anthropic:v2',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      },
    );

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:codex:v1' as ProviderSessionId,
      ),
    ).resolves.toMatchObject({
      provider: TEST_CODEX_PROVIDER_ID,
      status: 'active',
    });
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        'provider-session:test:anthropic:v1' as ProviderSessionId,
      ),
    ).resolves.toBeNull();

    await expect(
      runtime.sessionOps.getAgentTurnContext({
        workspaceFolder,
        executionProviderId: TEST_CODEX_PROVIDER_ID,
        chatJid,
      }),
    ).resolves.toMatchObject({
      providerSessionId: 'provider-session:test:codex:v1',
      externalSessionId: 'provider-session:test:codex:v1',
    });
    await expect(
      runtime.sessionOps.getAgentTurnContext({
        workspaceFolder,
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      }),
    ).resolves.toMatchObject({
      providerSessionId: 'provider-session:test:anthropic:v2',
      externalSessionId: 'provider-session:test:anthropic:v2',
    });
  });

  it('rejects provider session ids already owned by another agent session', async () => {
    await runtime.sessionOps.setSession(
      'group-session-owner-a',
      'provider-session:test:owned',
      null,
      {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid: 'tg:group-session-owner-a',
      },
    );

    await expect(
      runtime.sessionOps.setSession(
        'group-session-owner-b',
        'provider-session:test:owned',
        null,
        {
          executionProviderId: TEST_EXECUTION_PROVIDER_ID,
          chatJid: 'tg:group-session-owner-b',
        },
      ),
    ).rejects.toThrow(/already owned by another session/);
  });

  it('keeps provider-session ownership stable under concurrent claim races', async () => {
    const sharedSessionId = 'provider-session:test:race-owned';
    const contenders = [
      {
        workspaceFolder: 'group-session-race-a',
        chatJid: 'tg:group-session-race-a',
      },
      {
        workspaceFolder: 'group-session-race-b',
        chatJid: 'tg:group-session-race-b',
      },
    ] as const;

    const results = await Promise.allSettled(
      contenders.map((contender) =>
        runtime.sessionOps.setSession(
          contender.workspaceFolder,
          sharedSessionId,
          null,
          {
            executionProviderId: TEST_EXECUTION_PROVIDER_ID,
            chatJid: contender.chatJid,
          },
        ),
      ),
    );

    const fulfilled = results
      .map((result, index) => ({ result, index }))
      .filter((entry) => entry.result.status === 'fulfilled');
    const rejected = results
      .map((result, index) => ({ result, index }))
      .filter((entry) => entry.result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].result as PromiseRejectedResult).reason).toBeInstanceOf(
      Error,
    );
    expect(
      String((rejected[0].result as PromiseRejectedResult).reason),
    ).toContain('already owned by another session');

    const winner = contenders[fulfilled[0]!.index]!;
    const loser = contenders[rejected[0]!.index]!;

    const winnerContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: winner.workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: winner.chatJid,
      threadId: null,
    });
    expect(winnerContext).toMatchObject({
      providerSessionId: sharedSessionId,
      externalSessionId: sharedSessionId,
    });
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        sharedSessionId as ProviderSessionId,
      ),
    ).resolves.toMatchObject({
      id: sharedSessionId,
      agentSessionId: winnerContext.agentSessionId,
      status: 'active',
    });

    const loserContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: loser.workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: loser.chatJid,
      threadId: null,
    });
    expect(loserContext).not.toHaveProperty('providerSessionId');
    expect(loserContext).not.toHaveProperty('externalSessionId');
  });

  it('rejects unsafe provider session ids before persisting resume state', async () => {
    await expect(
      runtime.sessionOps.setSession('group-session-unsafe', '../escape', null, {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid: 'tg:group-session-unsafe',
      }),
    ).rejects.toThrow(/Invalid provider session id/);
  });

  it('keeps canonical turn context stable after expiring provider session metadata', async () => {
    const workspaceFolder = 'group-session-expiry';
    const chatJid = 'tg:group-session-expiry';
    const sessionId = 'provider-session:test:expire';

    await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });

    const before = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    await runtime.sessionOps.expireProviderSession({
      providerSessionId: sessionId,
      agentSessionId: before.agentSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: sessionId,
    });

    const resumed = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    expect(resumed.agentSessionId).toBe(before.agentSessionId);
    expect(resumed).not.toHaveProperty('providerSessionId');
    expect(resumed).not.toHaveProperty('externalSessionId');
  });

  it('does not expire provider sessions when ownership predicates are incomplete', async () => {
    const workspaceFolder = 'group-session-expiry-incomplete';
    const chatJid = 'tg:group-session-expiry-incomplete';
    const sessionId = 'provider-session:test:expire-incomplete';

    await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });

    const before = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    await runtime.sessionOps.expireProviderSession({
      providerSessionId: sessionId,
      agentSessionId: '',
      provider: '',
      externalSessionId: '',
    });

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        sessionId as ProviderSessionId,
      ),
    ).resolves.toMatchObject({
      id: sessionId,
      agentSessionId: before.agentSessionId,
      status: 'active',
    });
  });

  it('does not expire by providerSessionId when ownership predicates mismatch', async () => {
    const firstGroup = 'group-session-expiry-guard-a';
    const secondGroup = 'group-session-expiry-guard-b';
    const firstChat = 'tg:group-session-expiry-guard-a';
    const secondChat = 'tg:group-session-expiry-guard-b';
    const firstSessionId = 'provider-session:test:expiry-guard:a';
    const secondSessionId = 'provider-session:test:expiry-guard:b';

    await runtime.sessionOps.setSession(firstGroup, firstSessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: firstChat,
    });
    await runtime.sessionOps.setSession(secondGroup, secondSessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: secondChat,
    });

    const firstContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: firstGroup,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: firstChat,
      threadId: null,
    });
    const secondContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder: secondGroup,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: secondChat,
      threadId: null,
    });

    await runtime.sessionOps.expireProviderSession({
      providerSessionId: firstSessionId,
      agentSessionId: secondContext.agentSessionId,
      provider: TEST_EXECUTION_PROVIDER_ID,
      externalSessionId: firstSessionId,
    });

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        firstSessionId as ProviderSessionId,
      ),
    ).resolves.toMatchObject({
      status: 'active',
      agentSessionId: firstContext.agentSessionId,
    });
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        secondSessionId as ProviderSessionId,
      ),
    ).resolves.toMatchObject({
      status: 'active',
      agentSessionId: secondContext.agentSessionId,
    });
  });

  it('resets only the targeted scoped conversation state and preserves sibling scopes', async () => {
    const workspaceFolder = 'group-session-scope-reset';
    const conversationA = 'tg:group-session-scope-reset:A';
    const conversationB = 'tg:group-session-scope-reset:B';
    const sessionA = 'provider-session:test:scope-reset:a';
    const sessionB = 'provider-session:test:scope-reset:b';

    await runtime.sessionOps.setSession(workspaceFolder, sessionA, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: conversationA,
    });
    await runtime.sessionOps.setSession(workspaceFolder, sessionB, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: conversationB,
    });

    await runtime.sessionOps.deleteSession(workspaceFolder, null, {
      chatJid: conversationA,
    });

    const resetContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: conversationA,
      threadId: null,
    });
    const siblingContext = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid: conversationB,
      threadId: null,
    });

    expect(resetContext).not.toHaveProperty('providerSessionId');
    expect(resetContext).not.toHaveProperty('externalSessionId');
    expect(siblingContext).toMatchObject({
      providerSessionId: sessionB,
      externalSessionId: sessionB,
    });
  });

  it('clears scoped session state even when run history references the session', async () => {
    const workspaceFolder = 'group-session-delete-with-run';
    const chatJid = 'tg:group-session-delete-with-run';
    const sessionId = 'provider-session:test:delete-with-run';
    const runId = 'agent-run:test:delete-with-session' as AgentRunId;

    await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
    });
    const resume = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });

    await runtime.repositories.agentRuns.saveAgentRun({
      id: runId,
      appId: resume.appId as never,
      agentId: resume.agentId as never,
      configVersionId: `config:${DEFAULT_AGENT_ID}:1` as never,
      sessionId: resume.agentSessionId as never,
      llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      permissionDecisionIds: [],
      cause: 'message',
      status: 'completed',
      createdAt: '2026-04-28T00:00:00.000Z',
      startedAt: '2026-04-28T00:00:01.000Z',
      endedAt: '2026-04-28T00:00:02.000Z',
    });

    await runtime.sessionOps.deleteSession(workspaceFolder, null);

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        sessionId as ProviderSessionId,
      ),
    ).resolves.toBeNull();
    await expect(
      runtime.repositories.agentRuns.getAgentRun(runId),
    ).resolves.toMatchObject({ sessionId: resume.agentSessionId });

    const restarted = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: TEST_EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    expect(restarted.agentSessionId).toBeDefined();
    expect(restarted).not.toHaveProperty('externalSessionId');
  });

  it('hydrates continuity jobs only from the current session app scope', async () => {
    const conversationJid = 'app:shared:conversation';
    const threadId = 'topic-1';
    const agentId = 'agent:shared_agent';
    const appOneSession = await runtime.control.ensureAppSession({
      appId: 'app-one',
      conversationId: 'shared-conversation',
      chatJid: conversationJid,
      workspaceFolder: 'shared_agent',
      title: 'Shared App One',
    });
    const appTwoSession = await runtime.control.ensureAppSession({
      appId: 'app-two',
      conversationId: 'shared-conversation',
      chatJid: conversationJid,
      workspaceFolder: 'shared_agent',
      title: 'Shared App Two',
    });
    await runtime.ops.upsertJob(
      makeContinuityJob('job:continuity:app-one', {
        status: 'paused',
        session_id: appOneSession.sessionId,
        thread_id: threadId,
        execution_context: {
          conversationJid,
          threadId,
          workspaceKey: 'shared_agent',
          sessionId: appOneSession.sessionId,
        },
        notification_routes: [{ conversationJid, threadId, label: 'primary' }],
      }),
    );
    await runtime.ops.upsertJob(
      makeContinuityJob('job:continuity:app-two', {
        status: 'active',
        session_id: appTwoSession.sessionId,
        thread_id: threadId,
        execution_context: {
          conversationJid,
          threadId,
          workspaceKey: 'shared_agent',
          sessionId: appTwoSession.sessionId,
        },
        notification_routes: [{ conversationJid, threadId, label: 'primary' }],
      }),
    );

    const loadProductionContinuityJobs = (
      runtime.ops as unknown as {
        sessions: {
          loadProductionContinuityJobs(input: {
            session: {
              id: string;
              appId: string;
              agentId: string;
              conversationId: string;
              threadId?: string;
              status: 'active';
              createdAt: string;
              updatedAt: string;
            };
            limit: number;
          }): Promise<Array<{ id: string }>>;
        };
      }
    ).sessions.loadProductionContinuityJobs.bind(
      (runtime.ops as unknown as { sessions: unknown }).sessions,
    );

    await expect(
      loadProductionContinuityJobs({
        session: {
          id: appOneSession.sessionId,
          appId: 'app-one',
          agentId,
          conversationId: `conversation:${conversationJid}`,
          threadId: `thread:${conversationJid}:${threadId}`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        limit: 8,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'job:continuity:app-one' }),
    ]);
  });

  it('keeps session state isolated across independent test schemas', async () => {
    const isolated = await createPostgresIntegrationRuntime({
      schemaPrefix: 'session_continuity_isolated',
    });
    try {
      const workspaceFolder = 'group-session-isolation';
      const chatJid = 'tg:group-session-isolation';
      const sessionId = 'provider-session:test:isolation';

      await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      });
      await isolated.sessionOps.setSession(workspaceFolder, sessionId, null, {
        executionProviderId: TEST_EXECUTION_PROVIDER_ID,
        chatJid,
      });

      await expect(
        runtime.sessionOps.getAgentTurnContext({
          workspaceFolder,
          executionProviderId: TEST_EXECUTION_PROVIDER_ID,
          chatJid,
          threadId: null,
        }),
      ).resolves.toMatchObject({
        agentSessionId: expect.stringContaining('group-session-isolation'),
      });
      await expect(
        isolated.sessionOps.getAgentTurnContext({
          workspaceFolder,
          executionProviderId: TEST_EXECUTION_PROVIDER_ID,
          chatJid,
          threadId: null,
        }),
      ).resolves.toMatchObject({
        agentSessionId: expect.stringContaining('group-session-isolation'),
      });
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);
});

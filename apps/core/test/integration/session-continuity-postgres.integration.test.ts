import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentRunId } from '@core/domain/events/events.js';
import type { ProviderSessionId } from '@core/domain/sessions/sessions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

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

  it('returns canonical MyClaw turn context even when provider artifact metadata exists', async () => {
    const groupFolder = 'group-session-mode';
    const chatJid = 'tg:group-session-mode';
    const sessionId = 'provider-session:test:mode';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
    });

    const withoutArtifact = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(withoutArtifact).toMatchObject({
      appId: expect.any(String),
      agentId: expect.any(String),
      agentSessionId: expect.any(String),
    });

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
      latestArtifactId: 'provider-session-artifact:test:mode',
    });

    const withArtifact = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(withArtifact.agentSessionId).toBe(withoutArtifact.agentSessionId);
    expect(withArtifact).toMatchObject({
      providerSessionId: sessionId,
      externalSessionId: sessionId,
      latestArtifactId: 'provider-session-artifact:test:mode',
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
      groupFolder: 'runtime_workspace_folder',
      chatJid,
      threadId: null,
    });

    expect(context).toMatchObject({
      appId: 'default',
      agentId: 'agent:bound_skill_agent',
      agentSessionId: 'agent-session:runtime_workspace_folder',
    });
  });

  it('replaces provider session per scope without clobbering a thread scope', async () => {
    const groupFolder = 'group-session-replacement';
    const chatJid = 'tg:group-session-replacement';
    const threadId = 'thread-1';

    await runtime.sessionOps.setSession(
      groupFolder,
      'provider-session:test:root:v1',
      null,
      {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:root:v1',
      },
    );
    await runtime.sessionOps.setSession(
      groupFolder,
      'provider-session:test:thread:v1',
      threadId,
      {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:thread:v1',
      },
    );
    await runtime.sessionOps.setSession(
      groupFolder,
      'provider-session:test:root:v2',
      null,
      {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:root:v2',
      },
    );

    const rootResume = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
      chatJid,
      threadId: null,
    });
    const threadResume = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
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

  it('rejects provider session ids already owned by another agent session', async () => {
    await runtime.sessionOps.setSession(
      'group-session-owner-a',
      'provider-session:test:owned',
      null,
      {
        chatJid: 'tg:group-session-owner-a',
        latestArtifactId: 'provider-session-artifact:test:owned:a',
      },
    );

    await expect(
      runtime.sessionOps.setSession(
        'group-session-owner-b',
        'provider-session:test:owned',
        null,
        {
          chatJid: 'tg:group-session-owner-b',
          latestArtifactId: 'provider-session-artifact:test:owned:b',
        },
      ),
    ).rejects.toThrow(/already owned by another session/);
  });

  it('rejects unsafe provider session ids before persisting resume state', async () => {
    await expect(
      runtime.sessionOps.setSession('group-session-unsafe', '../escape', null, {
        chatJid: 'tg:group-session-unsafe',
        latestArtifactId: 'provider-session-artifact:test:unsafe',
      }),
    ).rejects.toThrow(/Invalid provider session id/);
  });

  it('keeps canonical turn context stable after expiring provider session metadata', async () => {
    const groupFolder = 'group-session-expiry';
    const chatJid = 'tg:group-session-expiry';
    const sessionId = 'provider-session:test:expire';
    const latestArtifactId = 'provider-session-artifact:test:expire';

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
      latestArtifactId,
    });

    const before = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
      chatJid,
      threadId: null,
    });

    await runtime.sessionOps.expireProviderSession({
      providerSessionId: sessionId,
      agentSessionId: before.agentSessionId,
      provider: 'anthropic',
      externalSessionId: sessionId,
    });

    const resumed = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(resumed.agentSessionId).toBe(before.agentSessionId);
    expect(resumed).not.toHaveProperty('providerSessionId');
    expect(resumed).not.toHaveProperty('externalSessionId');
    expect(resumed).not.toHaveProperty('latestArtifactId');
  });

  it('clears scoped session state even when run history references the session', async () => {
    const groupFolder = 'group-session-delete-with-run';
    const chatJid = 'tg:group-session-delete-with-run';
    const sessionId = 'provider-session:test:delete-with-run';
    const runId = 'agent-run:test:delete-with-session' as AgentRunId;

    await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
      chatJid,
      latestArtifactId: 'provider-session-artifact:test:delete-with-run',
    });
    const resume = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
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
      permissionDecisionIds: [],
      cause: 'message',
      status: 'completed',
      createdAt: '2026-04-28T00:00:00.000Z',
      startedAt: '2026-04-28T00:00:01.000Z',
      endedAt: '2026-04-28T00:00:02.000Z',
    });

    await runtime.sessionOps.deleteSession(groupFolder, null);

    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        sessionId as ProviderSessionId,
      ),
    ).resolves.toBeNull();
    await expect(
      runtime.repositories.agentRuns.getAgentRun(runId),
    ).resolves.toMatchObject({ sessionId: undefined });

    const restarted = await runtime.sessionOps.getAgentTurnContext({
      groupFolder,
      chatJid,
      threadId: null,
    });
    expect(restarted.agentSessionId).toBeDefined();
    expect(restarted).not.toHaveProperty('externalSessionId');
    expect(restarted).not.toHaveProperty('latestArtifactId');
  });

  it('keeps session state isolated across independent test schemas', async () => {
    const isolated = await createPostgresIntegrationRuntime({
      schemaPrefix: 'session_continuity_isolated',
    });
    try {
      const groupFolder = 'group-session-isolation';
      const chatJid = 'tg:group-session-isolation';
      const sessionId = 'provider-session:test:isolation';

      await runtime.sessionOps.setSession(groupFolder, sessionId, null, {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:isolation:primary',
      });
      await isolated.sessionOps.setSession(groupFolder, sessionId, null, {
        chatJid,
        latestArtifactId: 'provider-session-artifact:test:isolation:isolated',
      });

      await expect(
        runtime.sessionOps.getAgentTurnContext({
          groupFolder,
          chatJid,
          threadId: null,
        }),
      ).resolves.toMatchObject({
        agentSessionId: expect.stringContaining('group-session-isolation'),
      });
      await expect(
        isolated.sessionOps.getAgentTurnContext({
          groupFolder,
          chatJid,
          threadId: null,
        }),
      ).resolves.toMatchObject({
        agentSessionId: expect.stringContaining('group-session-isolation'),
      });
    } finally {
      await isolated.cleanup();
    }
  });
});

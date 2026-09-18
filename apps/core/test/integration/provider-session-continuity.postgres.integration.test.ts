import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProviderSessionId } from '@core/domain/sessions/sessions.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('provider-session continuity', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'provider_session_continuity',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('selects no process-local row or lifecycle side effect while preserving a durable row', async () => {
    const workspaceFolder = 'continuity-agent';
    const chatJid = 'app:test:continuity';
    const durableSessionId = 'deepagents:durable';
    const processLocalSessionId = 'claude:stale';

    await runtime.sessionOps.setSession(
      workspaceFolder,
      durableSessionId,
      null,
      {
        executionProviderId: 'deepagents:langchain',
        chatJid,
      },
    );
    await runtime.sessionOps.setSession(
      workspaceFolder,
      processLocalSessionId,
      null,
      {
        executionProviderId: 'anthropic:claude-agent-sdk',
        chatJid,
      },
    );
    await runtime.repositories.providerSessions.markProviderSessionStatus(
      processLocalSessionId as ProviderSessionId,
      'maintenance_compact',
      new Date().toISOString(),
    );

    const processLocal = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: 'anthropic:claude-agent-sdk',
      providerSessionContinuity: 'process_local',
      chatJid,
      threadId: null,
      promoteReadyProviderSession: true,
    });
    expect(processLocal).not.toHaveProperty('providerSessionId');
    expect(processLocal).not.toHaveProperty('latestProviderSessionLocked');
    await expect(
      runtime.repositories.providerSessions.getProviderSession(
        processLocalSessionId as ProviderSessionId,
      ),
    ).resolves.toMatchObject({ status: 'maintenance_compact' });

    await expect(
      runtime.sessionOps.getAgentTurnContext({
        workspaceFolder,
        executionProviderId: 'deepagents:langchain',
        providerSessionContinuity: 'durable_resume',
        chatJid,
        threadId: null,
      }),
    ).resolves.toMatchObject({
      providerSessionId: durableSessionId,
      externalSessionId: durableSessionId,
    });
    await expect(
      runtime.repositories.providerSessions.getLatestProviderSession({
        agentSessionId: processLocal.agentSessionId,
        durableExecutionProviderIds: ['deepagents:langchain'],
      }),
    ).resolves.toMatchObject({ provider: 'deepagents:langchain' });
  });
});

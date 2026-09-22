import { describe, expect, it, vi } from 'vitest';

import { CanonicalSessionOpsService } from '@core/adapters/storage/postgres/services/canonical-session-ops-service.js';
import type { PostgresCanonicalSessionRepository } from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';

describe('CanonicalSessionOpsService', () => {
  it('hydrates durable memory while excluding process-local provider state', async () => {
    const getAgentTurnContext = vi.fn(async (input) => ({
      appId: 'app-one',
      agentId: 'agent:main',
      agentSessionId: 'agent-session:main',
      ...(input.includeProviderSession
        ? {
            providerSessionId: 'provider-session:stale',
            externalSessionId: 'claude-session:stale',
          }
        : {}),
    }));
    const service = new CanonicalSessionOpsService(
      { getAgentTurnContext } as never,
      {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'agent-session:main',
            appId: 'app-one',
            agentId: 'agent:main',
            conversationId: 'conversation:one',
            status: 'active',
            createdAt: '2026-09-22T00:00:00.000Z',
            updatedAt: '2026-09-22T00:00:00.000Z',
          })),
        } as never,
        loadAppMemoryItems: vi.fn(async () => [
          {
            id: 'memory:one',
            kind: 'preference',
            key: 'style',
            value: 'concise',
            subject: {},
          },
        ]),
      },
    );

    const context = await service.getAgentTurnContext({
      workspaceFolder: 'main',
      executionProviderId: 'anthropic:claude-agent-sdk',
      providerSessionContinuity: 'process_local',
      chatJid: 'gantry:app-one:conversation:one',
    });

    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ includeProviderSession: false }),
    );
    expect(context).not.toHaveProperty('providerSessionId');
    expect(context.memoryContextBlock).toContain('concise');
  });

  it('loads continuity jobs with runtime jids from provider-account scoped session ids', async () => {
    const service = new CanonicalSessionOpsService(
      {} as PostgresCanonicalSessionRepository,
    ) as unknown as {
      continuityJobOps: {
        listJobs: ReturnType<typeof vi.fn>;
      };
      loadProductionContinuityJobs(input: {
        session: {
          id: string;
          appId: string;
          agentId: string;
          conversationId: string;
          threadId: string;
          status: 'active';
          createdAt: string;
          updatedAt: string;
        };
        limit: number;
      }): Promise<Array<{ id: string }>>;
    };

    service.continuityJobOps = {
      listJobs: vi.fn(async () => [
        {
          id: 'job:continuity',
          name: 'Continuity',
          status: 'active',
          execution_context: {
            conversationJid: 'sl:C123',
            threadId: '1710000000.000100',
          },
          notification_routes: [],
        },
      ]),
    };

    await expect(
      service.loadProductionContinuityJobs({
        session: {
          id: 'agent-session:main',
          appId: 'app-one',
          agentId: 'agent:main',
          conversationId: 'conversation:slack_one:sl:C123',
          threadId: 'thread:slack_one:sl:C123:1710000000.000100',
          status: 'active',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        limit: 3,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'job:continuity' })]);

    expect(service.continuityJobOps.listJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationJid: 'sl:C123',
        threadId: '1710000000.000100',
      }),
    );
  });
});

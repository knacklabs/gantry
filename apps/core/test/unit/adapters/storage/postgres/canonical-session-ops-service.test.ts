import { describe, expect, it, vi } from 'vitest';

import { CanonicalSessionOpsService } from '@core/adapters/storage/postgres/services/canonical-session-ops-service.js';
import type { PostgresCanonicalSessionRepository } from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';

describe('CanonicalSessionOpsService', () => {
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

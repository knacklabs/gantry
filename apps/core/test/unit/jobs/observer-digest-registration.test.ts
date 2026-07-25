import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRoute } from '@core/domain/types.js';

function makeRoute(
  overrides: Partial<ConversationRoute> = {},
): ConversationRoute {
  return {
    name: 'Route',
    folder: 'agent',
    trigger: 'Agent',
    added_at: '2026-05-08T00:00:00.000Z',
    conversationKind: 'channel',
    ...overrides,
  };
}

const ELIGIBLE_STATUS = {
  eligible: true as const,
  owner: {
    recipient: 'owner-1',
    conversation: 'owner-dm',
    conversationJid: 'sl:D999',
    providerAccountId: 'slack_default',
    providerId: 'slack',
    externalConversationId: 'D999',
  },
  schedule: { timezone: 'UTC', sendAt: '09:00', maxInsights: 5 },
};

async function loadSystemJobs(deliveryStatus: unknown) {
  vi.resetModules();
  vi.doMock('@core/config/index.js', () => ({
    MEMORY_DREAMING_CRON: '15 3 * * *',
    MEMORY_MAINTENANCE_MAX_PENDING: 5_000,
    RUNTIME_MEMORY_DREAMING_ENABLED: false,
    RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED: false,
    getRuntimeSettingsForConfig: vi.fn(() => ({})),
    TIMEZONE: 'UTC',
    MEMORY_BACKFILL_ENABLED: false,
    MEMORY_BACKFILL_CRON: '45 3 * * *',
    MEMORY_BACKFILL_MAX_ITEMS_PER_RUN: 500,
    MEMORY_BACKFILL_MODE: 'auto',
    MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS: 100,
    MEMORY_EMBED_PROVIDER: 'disabled',
    MEMORY_EMBED_MODEL: 'text-embedding-3-small',
    MEMORY_EMBED_DIMENSIONS: 1536,
    MEMORY_EMBED_BATCH_SIZE: 16,
    OPENAI_DAILY_EMBED_LIMIT: 500,
  }));
  vi.doMock('@core/config/settings/observer-activation.js', () => ({
    resolveObserverDeliveryStatus: vi.fn(() => deliveryStatus),
  }));
  return import('@core/jobs/system-jobs.js');
}

describe('observer digest job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the digest job (silent, bare owner route) only when delivery is eligible', async () => {
    const { registerSystemJobs } = await loadSystemJobs(ELIGIBLE_STATUS);
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn().mockResolvedValue(undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs: vi.fn(async () => []),
        deleteJob: vi.fn(async () => undefined),
        upsertJob,
      },
    } as never);

    const digest = upsertJob.mock.calls
      .map((call) => call[0])
      .find((job) => job.prompt === '__system:observer_digest');
    expect(digest).toBeDefined();
    expect(digest.id).toBe('system:observer-digest:default');
    expect(digest.schedule_value).toBe('*/30 * * * *');
    expect(digest.silent).toBe(true);
    expect(digest.execution_context).toEqual({
      conversationJid: 'sl:D999',
      threadId: null,
      workspaceKey: 'agent',
      sessionId: null,
    });
    expect(digest.notification_routes).toEqual([
      {
        conversationJid: 'sl:D999',
        threadId: null,
        providerAccountId: 'slack_default',
        label: 'Observer digest',
      },
    ]);
  });

  it('does not register the digest job when delivery is ineligible', async () => {
    const { registerSystemJobs } = await loadSystemJobs({
      eligible: false,
      reason: 'delivery_disabled',
      message: 'off',
    });
    const upsertJob = vi.fn().mockResolvedValue({ created: true });

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById: vi.fn().mockResolvedValue(undefined),
        getAllJobs: vi.fn(async () => []),
        deleteJob: vi.fn(async () => undefined),
        upsertJob,
      },
    } as never);

    expect(
      upsertJob.mock.calls.some(
        (call) => call[0].prompt === '__system:observer_digest',
      ),
    ).toBe(false);
  });
});

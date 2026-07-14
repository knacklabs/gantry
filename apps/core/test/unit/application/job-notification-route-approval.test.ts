import { describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import type { RuntimeJobRepository } from '@core/domain/repositories/ops-repo.js';
import type { Job } from '@core/domain/types.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run',
    model: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    status: 'active',
    session_id: null,
    thread_id: 'thread-1',
    workspace_key: 'team',
    created_by: 'agent',
    created_at: '2026-04-24T00:00:00.000Z',
    updated_at: '2026-04-24T00:00:00.000Z',
    next_run: '2026-04-24T01:00:00.000Z',
    last_run: null,
    silent: false,
    cleanup_after_ms: 0,
    timeout_ms: 300000,
    max_retries: 0,
    retry_backoff_ms: 0,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    execution_context: {
      conversationJid: 'tg:team',
      threadId: 'thread-1',
      workspaceKey: 'team',
    },
    notification_routes: [
      {
        conversationJid: 'tg:team',
        threadId: 'thread-1',
        providerAccountId: 'telegram_main',
        label: 'primary',
      },
    ],
    ...overrides,
  };
}

function makeAccess() {
  return {
    sourceAgentFolder: 'team',
    originConversationJid: 'tg:team',
    originProviderAccountId: 'telegram_main',
    conversationBindings: {
      'tg:team': { folder: 'team', providerAccountId: 'telegram_main' },
      'tg:other': { folder: 'other' },
    },
    sourceAgentFolderJids: ['tg:team'],
    authThreadId: 'thread-1',
  };
}

describe('job notification route approval', () => {
  it('creates scheduler jobs with only authenticated route without extra approval', async () => {
    const upsertJob = vi.fn(async () => ({ created: true }));
    const approveJobNotificationRoutes = vi.fn(async () => ({
      approved: true,
      approvedConversationJid: 'tg:team',
    }));
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => undefined),
        upsertJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      approveJobNotificationRoutes,
    } as never);

    await service.upsertJobFromIpc({
      access: makeAccess(),
      name: 'Team digest',
      prompt: 'Summarize updates',
      scheduleType: 'interval',
      scheduleValue: '60000',
      notificationRoutes: [
        {
          conversationJid: 'tg:team',
          threadId: 'thread-1',
          providerAccountId: 'telegram_main',
          label: 'primary',
        },
      ],
    });

    expect(approveJobNotificationRoutes).not.toHaveBeenCalled();
    expect(upsertJob).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_routes: [
          {
            conversationJid: 'tg:team',
            threadId: 'thread-1',
            providerAccountId: 'telegram_main',
            label: 'primary',
          },
        ],
      }),
    );
  });

  it('treats same-conversation provider-account mismatch as outside authenticated context', async () => {
    const upsertJob = vi.fn(async () => ({ created: true }));
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => undefined),
        upsertJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.upsertJobFromIpc({
        access: makeAccess(),
        name: 'Cross account route',
        prompt: 'Run',
        scheduleType: 'interval',
        scheduleValue: '60000',
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: 'thread-1',
            providerAccountId: 'telegram_backup',
            label: 'primary',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(upsertJob).not.toHaveBeenCalled();
  });

  it('fails closed for cross-context routes when approval plumbing is unavailable', async () => {
    const upsertJob = vi.fn(async () => ({ created: true }));
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => undefined),
        upsertJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.upsertJobFromIpc({
        access: makeAccess(),
        name: 'Cross route',
        prompt: 'Run',
        scheduleType: 'interval',
        scheduleValue: '60000',
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: 'thread-1',
            providerAccountId: 'telegram_main',
            label: 'primary',
          },
          {
            conversationJid: 'tg:other',
            threadId: null,
            label: 'fallback',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(upsertJob).not.toHaveBeenCalled();
  });

  it('requires same-conversation approval authority for cross-context route updates', async () => {
    const updateJob = vi.fn(async () => undefined);
    const approveJobNotificationRoutes = vi.fn(async () => ({
      approved: true,
      approvedConversationJid: 'tg:different',
    }));
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => makeJob()),
        updateJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      approveJobNotificationRoutes,
    } as never);

    await expect(
      service.updateJob({
        jobId: 'job-1',
        access: makeAccess(),
        patch: {
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: 'thread-1',
              providerAccountId: 'telegram_main',
              label: 'primary',
            },
            {
              conversationJid: 'tg:other',
              threadId: null,
              label: 'fallback',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(approveJobNotificationRoutes).toHaveBeenCalledOnce();
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('keeps existing notification routes unchanged when approval is denied', async () => {
    const updateJob = vi.fn(async () => undefined);
    const approveJobNotificationRoutes = vi.fn(async () => ({
      approved: false,
      reason: 'timed out',
    }));
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => makeJob()),
        updateJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      approveJobNotificationRoutes,
    } as never);

    await expect(
      service.updateJob({
        jobId: 'job-1',
        access: makeAccess(),
        patch: {
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: 'thread-1',
              providerAccountId: 'telegram_main',
              label: 'primary',
            },
            {
              conversationJid: 'tg:other',
              threadId: null,
              label: 'fallback',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(updateJob).not.toHaveBeenCalled();
  });
});

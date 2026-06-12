import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { Job, JobRun } from '@core/domain/types.js';
import { notifyReleasedStaleJobLeases } from '@core/jobs/stale-lease-terminal.js';

function createJob(overrides: Partial<Job> = {}): Job {
  const now = '2026-05-12T09:00:00.000Z';
  return {
    id: 'job-1',
    name: 'Daily check',
    prompt: 'Check status',
    model: null,
    schedule_type: 'interval',
    schedule_value: '1h',
    status: 'active',
    session_id: 'session-1',
    thread_id: null,
    workspace_key: 'tg:team',
    created_by: 'agent',
    created_at: now,
    updated_at: now,
    next_run: '2026-05-12T10:00:00.000Z',
    last_run: now,
    silent: false,
    cleanup_after_ms: 86_400_000,
    timeout_ms: 300_000,
    max_retries: 3,
    retry_backoff_ms: 5_000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    notification_routes: [
      {
        conversationJid: 'telegram:team',
        threadId: null,
        label: 'primary',
      },
    ],
    ...overrides,
  };
}

function createRun(overrides: Partial<JobRun> = {}): JobRun {
  return {
    run_id: 'run-1',
    job_id: 'job-1',
    scheduled_for: '2026-05-12T08:55:00.000Z',
    started_at: '2026-05-12T08:56:00.000Z',
    ended_at: '2026-05-12T09:00:00.000Z',
    status: 'timeout',
    result_summary: null,
    error_summary: 'Scheduler run lease expired before completion.',
    retry_count: 1,
    notified_at: null,
    ...overrides,
  };
}

describe('notifyReleasedStaleJobLeases', () => {
  it('emits terminal evidence and marks successful notifications', async () => {
    const job = createJob();
    const run = createRun();
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      getJobRunById: vi.fn(async () => run),
      markJobRunNotified: vi.fn(async () => true),
    };
    const sendMessage = vi.fn(async () => true);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await notifyReleasedStaleJobLeases({
      releases: [
        {
          jobId: 'job-1',
          runId: 'run-1',
          releasedAt: '2026-05-12T09:00:00.000Z',
          runTimedOut: true,
          reason: 'lease_expired',
        },
      ],
      opsRepository,
      sendMessage,
      controlRepository: {
        getAppSessionById: vi.fn(async () => ({
          appId: 'app-1',
          sessionId: 'session-1',
          defaultResponseMode: 'webhook' as const,
          defaultWebhookId: 'webhook-1',
        })),
      },
      publishRuntimeEvent,
      runtimeAppId: 'default',
    });

    expect(sendMessage.mock.calls[0]?.[0]).toBe('telegram:team');
    expect(sendMessage.mock.calls[0]?.[1]).toContain('Timed out');
    expect(opsRepository.markJobRunNotified).toHaveBeenCalledWith('run-1');
    expect(
      publishRuntimeEvent.mock.calls.map((call) => call[0].eventType),
    ).toEqual([
      RUNTIME_EVENT_TYPES.RUN_TIMEOUT,
      RUNTIME_EVENT_TYPES.JOB_FAILED,
      RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
    ]);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        sessionId: 'session-1',
        responseMode: 'webhook',
        webhookId: 'webhook-1',
      }),
    );
  });
});

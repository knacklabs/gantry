import { describe, expect, it, vi } from 'vitest';

import type { Job } from '@core/domain/types.js';
import {
  notifySchedulerRunStart,
  notifySchedulerTerminalRunState,
} from '@core/jobs/execution-notifications.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    app_id: 'default',
    name: 'Daily summary',
    prompt: 'Summarize current status',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    linked_sessions: ['tg:scheduler'],
    session_id: null,
    thread_id: 'thread-1',
    execution_context: {
      conversationJid: 'tg:scheduler',
      threadId: 'thread-1',
      groupScope: 'scheduler_agent',
    },
    notification_routes: [
      {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-1',
        label: 'primary',
      },
    ],
    group_scope: 'scheduler_agent',
    created_by: 'human',
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    execution_mode: 'serialized',
    cleanup_after_ms: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  } as Job;
}

describe('jobs/execution-notifications', () => {
  it('sends start lifecycle notification for non-silent jobs', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const delivered = await notifySchedulerRunStart({
      job: makeJob(),
      runId: 'run-123456789',
      sendMessage,
    });

    expect(delivered).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Scheduler started: Daily summary'),
      { threadId: 'thread-1' },
    );
  });

  it('skips start notifications for silent jobs', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const delivered = await notifySchedulerRunStart({
      job: makeJob({ silent: true }),
      runId: 'run-1',
      sendMessage,
    });

    expect(delivered).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('prefers lifecycle update over summary fallback when update succeeds', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const update = vi.fn(async () => 'updated' as const);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'completed',
      summary: 'Result summary',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification: update,
    });

    expect(notified).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back once to summary notification when lifecycle update is unavailable', async () => {
    const sendMessage = vi.fn(async () => undefined);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'failed',
      summary: 'planned failure',
      nextRun: null,
      retryCount: 1,
      pauseReason: null,
      sendMessage,
    });

    expect(notified).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Scheduler failed: Daily summary'),
      { threadId: 'thread-1' },
    );
  });
});

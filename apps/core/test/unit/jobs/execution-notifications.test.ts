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
      expect.stringContaining('Running: Daily summary'),
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
      expect.stringContaining('Failed: Daily summary'),
      { threadId: 'thread-1' },
    );
  });

  it('sends a user-facing needs-permission receipt without repair commands', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'dead_lettered',
      summary:
        'Tool not on autonomous job allowlist: mcp__myclaw__browser_act. Recovery: request_permission { "toolName": "Browser" }',
      nextRun: null,
      retryCount: 1,
      pauseReason: 'Needs permission: mcp__myclaw__browser_act',
      sendMessage,
      durationMs: 41_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    const options = sendMessage.mock.calls[0]?.[2];
    expect(message).toContain('Needs permission: Daily summary');
    expect(message).toContain('Outcome: Could not use the browser');
    expect(message).toContain('Action: Browser access needs approval.');
    expect(message).not.toContain('request_permission');
    expect(options).toMatchObject({
      threadId: 'thread-1',
      actionAffordances: [
        { kind: 'scheduler_run_now', label: 'Retry now', jobId: 'job-1' },
        {
          kind: 'scheduler_show_last_logs',
          label: 'Show last 50 log lines',
          jobId: 'job-1',
        },
        { kind: 'scheduler_pause_job', label: 'Pause job', jobId: 'job-1' },
        {
          kind: 'scheduler_open',
          label: 'Open in scheduler',
          jobId: 'job-1',
        },
      ],
    });
  });
});

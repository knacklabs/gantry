import { describe, expect, it, vi } from 'vitest';

import type { Job, JobSetupState } from '@core/domain/types.js';
import {
  notifySchedulerSetupRequired,
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
      expect.objectContaining({ threadId: 'thread-1' }),
    );
  });

  it('cleans markdown job reports into readable terminal outcomes', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'KnackLabs Lead Maintenance' }),
      runId: 'run-1',
      runShortId: 4,
      runStatus: 'completed',
      summary:
        '## Final Job Report\n- *Mode*: B (KnackLabs lead finder) — Sun 12:05 IST.\n- *Added*: 2 leads to Bot Recommendation tab (rows 1918-1919), locations written to column K.',
      nextRun: '2026-05-17T08:35:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 382_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain(
      'Completed: KnackLabs Lead Maintenance (Run #4, 6m 22s)',
    );
    expect(message).toContain(
      'Outcome: Final Job Report Mode: B (KnackLabs lead finder)',
    );
    expect(message).toContain('Added: 2 leads');
    expect(message).not.toContain('##');
    expect(message).not.toContain('*Mode*');
    expect(message).not.toContain('T08:35:00.000Z');
  });

  it('turns queue bookkeeping JSON into a human memory maintenance outcome', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Memory Dreaming (main_agent tg:5759865942)' }),
      runId: 'run-1',
      runShortId: 6,
      runStatus: 'completed',
      summary: '{"queued":true,"pending":0,"deduped":false}',
      nextRun: '2026-05-15T21:45:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 13_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain(
      'Completed: Memory Dreaming (main_agent tg:5759865942) (Run #6, 13s)',
    );
    expect(message).toContain('Outcome: Memory maintenance completed.');
    expect(message).not.toContain('"queued"');
    expect(message).not.toContain('deduped');
  });

  it('hides runner diagnostics from failed job receipts', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'KnackLabs Lead Maintenance' }),
      runId: 'run-1',
      runShortId: 1,
      runStatus: 'failed',
      summary:
        'Missing tool access requirement before run. Tool not on autonomous run allowlist: Browser. Recovery: request_permission {"toolName":"Browser"}\nDiagnostics: lastTool=SandboxNetworkAccess; pendingPermissions=0 (none); totalToolCalls=20; browserActivity=0;',
      nextRun: '2026-05-17T05:49:52.673Z',
      retryCount: 1,
      pauseReason: null,
      sendMessage,
      durationMs: 180_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Outcome: Missing Browser access for this job.');
    expect(message).toContain(
      'Action: Approve the missing access, then retry the job.',
    );
    expect(message).not.toContain('Diagnostics:');
    expect(message).not.toContain('lastTool=');
    expect(message).not.toContain('pendingPermissions=');
  });

  it('summarizes JSON arrays without leaking raw payloads', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'completed',
      summary: '[{"queued":true},{"queued":false}]',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Outcome: Job returned 2 items.');
    expect(message).not.toContain('[{');
    expect(message).not.toContain('"queued"');
  });

  it('does not expose invalid scheduler next-run data in receipts', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'failed',
      summary: 'failed',
      nextRun: 'not-a-date',
      retryCount: 1,
      pauseReason: null,
      sendMessage,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain(
      'Next: Runs again after the schedule is repaired.',
    );
    expect(message).not.toContain('not-a-date');
  });

  it('sends a user-facing needs-permission receipt without repair commands', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'dead_lettered',
      summary:
        'Tool not on autonomous run allowlist: mcp__gantry__browser_act. Recovery: request_permission { "toolName": "Browser" }',
      nextRun: null,
      retryCount: 1,
      pauseReason: 'Needs permission: mcp__gantry__browser_act',
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
        { kind: 'scheduler_pause_job', label: 'Pause job', jobId: 'job-1' },
        {
          kind: 'scheduler_open',
          label: 'Open in scheduler',
          jobId: 'job-1',
        },
      ],
    });
  });

  it('suppresses duplicate needs-permission summaries when setup notification owns the action', async () => {
    const sendMessage = vi.fn(async () => undefined);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'failed',
      summary:
        'Permission denied for Bash. Tool not on autonomous run allowlist: RunCommand. Recovery: request_permission { "toolName": "RunCommand", "rule": "npm test *" }',
      nextRun: null,
      retryCount: 1,
      pauseReason: 'Setup required',
      sendMessage,
      durationMs: 41_000,
    });

    expect(notified).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends setup-required notifications with plain user actions', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const setupState: JobSetupState = {
      state: 'draft_only',
      checked_at: '2026-05-16T00:00:00.000Z',
      fingerprint: 'setup-fingerprint',
      blockers: [
        {
          state: 'draft_only',
          requirementType: 'local_cli',
          requirementId: 'google.sheets.write',
          message:
            'Google Sheets write using gog needs reviewed local CLI access before this job can run autonomously.',
          nextAction:
            'propose_capability {"capabilityId":"google.sheets.write","source":"local_cli","executablePath":"/usr/local/bin/gog","executableVersion":"v0.9.0","executableHash":"sha256:abc123"}',
        },
      ],
    };

    const delivered = await notifySchedulerSetupRequired({
      job: makeJob({ name: 'Lead maintenance' }),
      setupState,
      sendMessage,
    });

    expect(delivered).toBe(true);
    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Setup needed: Lead maintenance');
    expect(message).toContain('Why: Google Sheets write');
    expect(message).toContain(
      'Action: Approve Google Sheets write, then resume the job.',
    );
    expect(message).not.toContain('request_permission');
    expect(message).not.toContain('/usr/local/bin/gog sheets append');
  });

  it('describes expected long-running timeout recovery without blaming job scope', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ timeout_ms: 300_000 }),
      runId: 'run-1',
      runStatus: 'timeout',
      summary: 'Scheduler run lease expired before completion.',
      nextRun: '2026-05-15T16:00:00.000Z',
      retryCount: 1,
      pauseReason: null,
      sendMessage,
      durationMs: 362_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Timed out: Daily summary');
    expect(message).toContain(
      'Outcome: Scheduler run lease expired before completion.',
    );
    expect(message).toContain(
      'Action: Rerun with a longer job timeout if this work is expected to take more time.',
    );
    expect(message).not.toContain('Narrow the job scope');
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      actionAffordances: [
        { kind: 'scheduler_run_now', label: 'Retry now', jobId: 'job-1' },
        { kind: 'scheduler_pause_job', label: 'Pause job', jobId: 'job-1' },
        {
          kind: 'scheduler_open',
          label: 'Open in scheduler',
          jobId: 'job-1',
        },
      ],
    });
  });

  it('uses the final job report instead of intermediate job chatter', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'KnackLabs Lead Maintenance' }),
      runId: 'run-1',
      runShortId: 12,
      runStatus: 'completed',
      summary:
        'Sunday 22:05 IST -> Mode B. Let me load tools and check Hot Leads dedup.Now searching for the 22:00 slot query.CashFlo + Sachit already there (Feb). Searching for other targets.## Final Job Report\nMode: B (KnackLabs lead finder)\nAdded: 0 leads\nReason: heavy dedup overlap.',
      nextRun: '2026-05-18T02:35:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 567_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Completed: KnackLabs Lead Maintenance');
    expect(message).toContain('Outcome: Final Job Report Mode: B');
    expect(message).toContain('Added: 0 leads');
    expect(message).not.toContain('Let me load tools');
    expect(message).not.toContain('Now searching');
  });
});

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
      workspaceKey: 'scheduler_agent',
    },
    notification_routes: [
      {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-1',
        label: 'primary',
      },
    ],
    workspace_key: 'scheduler_agent',
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
      expect.stringContaining('**▶️ Running** · Daily summary'),
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

  it('does not block a run when start notification delivery hangs', async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn(() => new Promise<void>(() => undefined));
      const delivered = notifySchedulerRunStart({
        job: makeJob(),
        runId: 'run-1',
        sendMessage,
      });

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(delivered).resolves.toBe(false);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
      expect.stringContaining('**❌ Failed** · Daily summary'),
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
    expect(message).toContain('**✅ Completed**');
    expect(message).toContain('· KnackLabs Lead Maintenance · 6m 22s');
    expect(message).toContain(
      'Final Job Report Mode: B (KnackLabs lead finder)',
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
    expect(message).toContain('**✅ Completed**');
    expect(message).toContain(
      '· Memory Dreaming (main_agent tg:5759865942) · 13s',
    );
    expect(message).toContain('Memory maintenance completed.');
    expect(message).not.toContain('"queued"');
    expect(message).not.toContain('deduped');
  });

  it('sends pending memory review guidance through scheduler notification routes', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Memory Dreaming (main_agent tg:5759865942)' }),
      runId: 'run-1',
      runShortId: 7,
      runStatus: 'completed',
      summary: 'Memory dreaming completed: 3 promoted, 4 sent to review.',
      nextRun: '2026-05-15T21:45:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 14_000,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining(
        '**📝 Needs memory review** · Memory Dreaming (main_agent tg:5759865942)',
      ),
      { threadId: 'thread-1' },
    );
    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain(
      'Memory dreaming completed: 3 promoted, 4 sent to review.',
    );
    expect(message).toContain(
      'Action: Ask the agent to show pending memory reviews, then approve, reject, or edit by number.',
    );
    expect(message).not.toContain('memory_review_pending');
  });

  it('keeps pending memory review guidance in lifecycle update summaries', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const updateLifecycleNotification = vi.fn(async () => 'updated' as const);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Memory Dreaming (main_agent tg:5759865942)' }),
      runId: 'run-1',
      runShortId: 8,
      runStatus: 'completed',
      summary:
        'Memory dreaming completed with no memory changes. 7 pending memory reviews need review.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification,
      durationMs: 15_000,
    });

    expect(notified).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(updateLifecycleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        runStatus: 'completed',
        summaryMessage: expect.stringContaining(
          '**📝 Needs memory review** · Memory Dreaming (main_agent tg:5759865942)',
        ),
      }),
    );
    const summaryMessage = String(
      updateLifecycleNotification.mock.calls[0]?.[0].summaryMessage,
    );
    expect(summaryMessage).toContain(
      'Memory dreaming completed with no memory changes. 7 pending memory reviews need review.',
    );
    expect(summaryMessage).toContain(
      'Action: Ask the agent to show pending memory reviews, then approve, reject, or edit by number.',
    );
    expect(summaryMessage).not.toContain('memory_review_pending');
  });

  it('hides runner diagnostics from failed job receipts', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'KnackLabs Lead Maintenance' }),
      runId: 'run-1',
      runShortId: 1,
      runStatus: 'failed',
      summary:
        'Missing tool access requirement before run. Tool not on autonomous run allowlist: Browser. Recovery: request_access {"target":{"kind":"capability","id":"browser.use"},"temporaryOnly":false,"reason":"This autonomous run requires Browser access."}\nDiagnostics: lastTool=SandboxNetworkAccess; pendingPermissions=0 (none); totalToolCalls=20; browserActivity=0;',
      nextRun: '2026-05-17T05:49:52.673Z',
      retryCount: 1,
      pauseReason: null,
      sendMessage,
      durationMs: 180_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Missing Browser access for this job.');
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
    expect(message).toContain('Job returned 2 items.');
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
        'Tool not on autonomous run allowlist: mcp__gantry__browser_act. Recovery: request_access {"target":{"kind":"capability","id":"browser.use"},"temporaryOnly":false,"reason":"This autonomous run requires Browser access."}',
      nextRun: null,
      retryCount: 1,
      pauseReason: 'Needs permission: mcp__gantry__browser_act',
      sendMessage,
      durationMs: 41_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    const options = sendMessage.mock.calls[0]?.[2];
    expect(message).toContain('**🔐 Needs permission**');
    expect(message).toContain('· Daily summary');
    expect(message).toContain('Could not use the browser');
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
        'Permission denied for Bash. Tool not on autonomous run allowlist: RunCommand. Recovery: request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
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
      state: 'missing_capability',
      checked_at: '2026-05-16T00:00:00.000Z',
      fingerprint: 'setup-fingerprint',
      blockers: [
        {
          state: 'missing_capability',
          requirementType: 'local_cli',
          requirementId: 'acme.records.append',
          message:
            'Acme records append using acme needs reviewed local CLI access before this job can run autonomously.',
          nextAction:
            'request_access {"target":{"kind":"capability","id":"acme.records.append"},"reason":"Approve reviewed Acme records access."}',
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
    expect(message).toContain('**🛠️ Setup needed**');
    expect(message).toContain('· Lead maintenance');
    expect(message).toContain('Acme Records Append');
    expect(message).toContain(
      'Action: Approve Acme Records Append, then resume the job.',
    );
    expect(message).not.toContain('request_permission');
    expect(message).not.toContain('/usr/local/bin/acme records append');
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
    expect(message).toContain('**⏱️ Timed out**');
    expect(message).toContain('· Daily summary');
    expect(message).toContain('Scheduler run lease expired before completion.');
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
    expect(message).toContain('**✅ Completed**');
    expect(message).toContain('· KnackLabs Lead Maintenance');
    expect(message).toContain('Final Job Report Mode: B');
    expect(message).toContain('Added: 0 leads');
    expect(message).not.toContain('Let me load tools');
    expect(message).not.toContain('Now searching');
  });
});

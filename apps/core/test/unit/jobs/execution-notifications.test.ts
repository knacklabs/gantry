import { describe, expect, it, vi } from 'vitest';

import type { Job, JobSetupState } from '@core/domain/types.js';
import {
  notifySchedulerRunRecovered,
  notifySchedulerSetupRequired,
  notifySchedulerTerminalRunState,
} from '@core/jobs/execution-notifications.js';
import type { MemoryReviewCreatedNotification } from '@core/jobs/memory-dreaming-job-outcome.js';
import type { ReviewMessageView } from '@core/memory/review-message-view.js';

function makeReviewView(
  overrides: Partial<ReviewMessageView> = {},
): ReviewMessageView {
  const reviewId = overrides.reviewId ?? 'mrv_abc123';
  return {
    reviewId,
    kind: 'contradiction',
    title: '🧠 Memory review · conflicting note',
    topic: 'user.location',
    sides: [
      { label: 'Now', value: 'lives in Paris', source: 'chat' },
      { label: 'New', value: 'lives in Berlin', source: 'chat' },
    ],
    change: '"lives in Berlin"',
    why: 'a newer statement contradicts the stored note',
    evidence: [{ source: 'chat', snippet: 'I moved to Berlin last week' }],
    affordances: [
      { label: 'Approve', decision: 'approve', reviewId },
      { label: 'Reject', decision: 'reject', reviewId },
      { label: 'Edit', decision: 'edit', reviewId },
    ],
    ...overrides,
  };
}

function makeReviewNotification(
  overrides: Partial<MemoryReviewCreatedNotification> = {},
): MemoryReviewCreatedNotification {
  const pendingCount = overrides.pendingCount ?? 1;
  const morePendingCount = Math.max(0, pendingCount - 1);
  const reviewMessageView =
    overrides.reviewMessageView ??
    makeReviewView(morePendingCount > 0 ? { morePendingCount } : {});
  return {
    kind: 'memory_review_created',
    reviewMessageView,
    createdReviewIds: [reviewMessageView.reviewId],
    pendingCount,
    ...overrides,
  };
}

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

function makeMemoryDreamingJob(overrides: Partial<Job> = {}): Job {
  return makeJob({
    id: 'system:dreaming:main_agent:test',
    name: 'Memory Dreaming (main_agent tg:5759865942)',
    prompt: '__system:memory_dream',
    schedule_type: 'cron',
    schedule_value: '15 3 * * *',
    created_by: 'agent',
    ...overrides,
  });
}

describe('jobs/execution-notifications', () => {
  it('sends recovery notifications for non-silent jobs', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const delivered = await notifySchedulerRunRecovered({
      job: makeJob(),
      runId: 'run-123456789',
      sendMessage,
    });

    expect(delivered).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Run recovered: previous worker lost its lease'),
      { threadId: 'thread-1' },
    );
  });

  it('retires lifecycle progress and preserves Run again controls', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const update = vi.fn(async () => [
      {
        route: {
          conversationJid: 'sl:C123',
          threadId: null,
          label: 'Primary',
        },
        status: 'updated' as const,
      },
    ]);

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
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        actionAffordances: [
          expect.objectContaining({
            kind: 'scheduler_run_now',
            label: 'Run again',
          }),
        ],
      }),
    );
  });

  it('sends one terminal outcome and no normal start notification', async () => {
    const sendMessage = vi.fn(async () => undefined);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-1',
      runStatus: 'failed',
      summary: 'RAW_JOB_FAILURE_SENTINEL: planned failure',
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
    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).not.toContain('Running');
    expect(message).not.toContain('RAW_JOB_FAILURE_SENTINEL');
    expect(message).not.toMatch(
      /^(?:Completed|Used|Changed|Delegated|Needs attention|Next):/m,
    );
  });

  it('cleans markdown job reports into readable terminal outcomes', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Fixture Lead Maintenance' }),
      runId: 'run-1',
      runShortId: 4,
      runStatus: 'completed',
      summary:
        '## Final Job Report\n- *Mode*: B (fixture lead finder) — Sun 12:05 IST.\n- *Added*: 2 leads to Fixture Leads tab (rows 1918-1919), locations written to column K.',
      nextRun: '2026-05-17T08:35:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 382_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('**✅ Completed**');
    expect(message).toContain('· Fixture Lead Maintenance · 6m 22s');
    expect(message).toContain('Mode: B (fixture lead finder)');
    expect(message).not.toContain('Final Job Report');
    expect(message).toContain('Added: 2 leads');
    expect(message).not.toContain('##');
    expect(message).not.toContain('*Mode*');
    expect(message).not.toContain('T08:35:00.000Z');
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      actionAffordances: [
        {
          kind: 'scheduler_run_now',
          label: 'Run again',
          jobId: 'job-1',
          runId: 'run-1',
        },
      ],
    });
  });

  it('sends compact memory dreaming completion notifications', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
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
    expect(message).toBe('Memory job done.');
    expect(message).not.toContain('"queued"');
    expect(message).not.toContain('deduped');
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Next:');
  });

  it('sends compact memory dreaming dedupe notifications', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runShortId: 6,
      runStatus: 'completed',
      summary: '{"queued":false,"pending":1,"deduped":true}',
      nextRun: '2026-05-15T21:45:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 13_000,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toBe('Memory job already running.');
  });

  it('sends pending memory review guidance through scheduler notification routes', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runShortId: 7,
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 4 sent to review.',
      nextRun: '2026-05-15T21:45:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 14_000,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      'Memory job needs review: 4 memory changes waiting.',
      expect.objectContaining({
        threadId: 'thread-1',
        actionAffordances: [],
      }),
    );
  });

  it('keeps pending memory review guidance in lifecycle update summaries', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const updateLifecycleNotification = vi.fn(async () => [
      {
        route: {
          conversationJid: 'sl:C123',
          threadId: null,
          label: 'Primary',
        },
        status: 'updated' as const,
      },
    ]);

    const notified = await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runShortId: 8,
      runStatus: 'completed',
      summary:
        'Memory dreaming needs attention: 7 pending memory reviews need review.',
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
        summaryMessage: 'Memory job needs review: 7 memory changes waiting.',
      }),
    );
  });

  it('sends compact blocked memory dreaming notifications', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runShortId: 9,
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 4 blocked.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 12_000,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      'Memory job needs attention: 4 memory changes blocked while creating reviews.',
      expect.objectContaining({
        threadId: 'thread-1',
        actionAffordances: [],
      }),
    );
  });

  it('hides runner diagnostics from failed job receipts', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Fixture Lead Maintenance' }),
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
      'Approve the missing access, then retry the job.',
    );
    expect(message).not.toContain('Needs attention:');
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
    expect(message).toContain('Stopped until the job is fixed or rerun.');
    expect(message).not.toContain('Next:');
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
    expect(message).toContain('Browser access needs approval.');
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('request_permission');
    expect(options).toMatchObject({
      threadId: 'thread-1',
      actionAffordances: [
        {
          kind: 'scheduler_pause_job',
          label: 'Pause job',
          jobId: 'job-1',
          runId: 'run-1',
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
      setupNotified: true,
      sendMessage,
      durationMs: 41_000,
    });

    expect(notified).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('folds a completed degraded run into one completed-with-limits card', async () => {
    const sendMessage = vi.fn(async () => undefined);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Lead maintenance' }),
      runId: 'run-degraded',
      runStatus: 'completed',
      summary: 'Imported 3 records.',
      nextRun: null,
      retryCount: 0,
      pauseReason: 'Setup required',
      setupNotified: false,
      diagnostics: {
        pendingPermissionRequests: 0,
        pendingPermissionToolNames: [],
        totalToolCalls: 1,
        browserActivityCount: 0,
        transientPermissionApprovals: [
          { toolName: 'RunCommand', mode: 'allow_once' },
        ],
        startupDiagnostics: [],
        latestStreamedOutputChars: 0,
        totalStreamedOutputChars: 0,
      },
      sendMessage,
    });

    expect(notified).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('**⚠️ Completed with limits**');
    expect(message).toContain('⚠️ Degraded:');
    expect(message).not.toContain('Setup needed');
  });

  it('keeps only the setup card when a blocker ends the run', async () => {
    const sendMessage = vi.fn(async () => undefined);

    const notified = await notifySchedulerTerminalRunState({
      job: makeJob(),
      runId: 'run-blocked',
      runStatus: 'paused',
      summary: 'Tool not on autonomous run allowlist: RunCommand.',
      nextRun: null,
      retryCount: 0,
      pauseReason: 'Setup required',
      setupNotified: true,
      sendMessage,
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
    expect(message).toContain("I couldn't finish before the job's time limit.");
    expect(message).not.toContain(
      'Scheduler run lease expired before completion.',
    );
    expect(message).toContain(
      'Rerun with a longer job timeout if this work is expected to take more time.',
    );
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('Narrow the job scope');
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      actionAffordances: [
        {
          kind: 'scheduler_pause_job',
          label: 'Pause job',
          jobId: 'job-1',
          runId: 'run-1',
        },
      ],
    });
  });

  it('uses the final job report instead of intermediate job chatter', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeJob({ name: 'Fixture Lead Maintenance' }),
      runId: 'run-1',
      runShortId: 12,
      runStatus: 'completed',
      summary:
        'Sunday 22:05 IST -> Mode B. Let me load tools and check Fixture Leads dedup.Now searching for the 22:00 slot query.ExampleCo + Sample Contact already there (Feb). Searching for other targets.## Final Job Report\nMode: B (fixture lead finder)\nAdded: 0 leads\nReason: heavy dedup overlap.',
      nextRun: '2026-05-18T02:35:00.000Z',
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      durationMs: 567_000,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('**✅ Completed**');
    expect(message).toContain('· Fixture Lead Maintenance');
    expect(message).toContain('Mode: B');
    expect(message).not.toContain('Final Job Report');
    expect(message).toContain('Added: 0 leads');
    expect(message).not.toContain('Let me load tools');
    expect(message).not.toContain('Now searching');
  });

  it('sends the review card + 3 decision affordances instead of a bare count', async () => {
    const sendMessage = vi.fn(async () => undefined);

    const notified = await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runShortId: 9,
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 1 sent to review.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      memoryReviewNotification: makeReviewNotification(),
    });

    expect(notified).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jid, text, options] = sendMessage.mock.calls[0] ?? [];
    expect(jid).toBe('tg:scheduler');
    // NOT the old bare count.
    expect(String(text)).not.toContain('memory changes waiting');
    // Compact-structured content + explicit reply-command fallback.
    expect(String(text)).toContain('🧠 Memory review · conflicting note');
    expect(String(text)).toContain('Topic: user.location');
    expect(String(text)).toContain('edit memory review mrv_abc123');
    expect(String(text)).toContain('approve mrv_abc123');
    // Native review view + the three decision buttons for the channel adapters.
    expect(options).toMatchObject({
      reviewMessageView: expect.objectContaining({ reviewId: 'mrv_abc123' }),
      actionAffordances: [
        {
          kind: 'memory_review_decision',
          label: 'Approve',
          reviewId: 'mrv_abc123',
          decision: 'approve',
        },
        {
          kind: 'memory_review_decision',
          label: 'Reject',
          reviewId: 'mrv_abc123',
          decision: 'reject',
        },
        {
          kind: 'memory_review_decision',
          label: 'Edit',
          reviewId: 'mrv_abc123',
          decision: 'edit',
        },
      ],
    });
  });

  it('appends a "+N more pending" line when several reviews are pending', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 3 sent to review.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      memoryReviewNotification: makeReviewNotification({
        createdReviewIds: ['mrv_abc123', 'mrv_two', 'mrv_three'],
        pendingCount: 3,
      }),
    });

    const text = String(sendMessage.mock.calls[0]?.[1]);
    expect(text).toContain('＋2 more pending reviews.');
  });

  it('retires lifecycle progress before sending the actionable review card', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const updateLifecycleNotification = vi.fn(async () => [
      {
        route: {
          conversationJid: 'sl:C123',
          threadId: null,
          label: 'Primary',
        },
        status: 'updated' as const,
      },
    ]);

    const notified = await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 1 sent to review.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification,
      memoryReviewNotification: makeReviewNotification(),
    });

    expect(notified).toBe(true);
    expect(updateLifecycleNotification).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      actionAffordances: [
        expect.objectContaining({ kind: 'memory_review_decision' }),
        expect.objectContaining({ kind: 'memory_review_decision' }),
        expect.objectContaining({ kind: 'memory_review_decision' }),
      ],
    });
  });

  it('keeps the concise count summary when no review context is supplied', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job: makeMemoryDreamingJob(),
      runId: 'run-1',
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 4 sent to review.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      'Memory job needs review: 4 memory changes waiting.',
      expect.objectContaining({ actionAffordances: [] }),
    );
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty(
      'reviewMessageView',
    );
  });
});

describe('setup cards', () => {
  it('lists every blocker with human labels plus the died-vs-degraded line and triggering step', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const setupState: JobSetupState = {
      state: 'missing_capability',
      checked_at: '2026-08-05T00:00:00.000Z',
      fingerprint: 'setup-many-blockers',
      blockers: [
        {
          state: 'missing_capability',
          requirementType: 'semantic_capability',
          requirementId: 'salesforce.leads.append',
          message: 'Capability missing.',
          nextAction: 'Approve the reviewed capability.',
        },
        {
          state: 'missing_capability',
          requirementType: 'browser',
          requirementId: 'Browser',
          message: 'Browser access missing.',
          nextAction: 'Approve Browser access.',
        },
        {
          state: 'missing_capability',
          requirementType: 'tool',
          requirementId: 'mcp__gantry__scheduler_run_now',
          message: 'Tool access missing.',
          nextAction: 'Approve the requested access.',
        },
        {
          state: 'missing_capability',
          requirementType: 'mcp_server',
          requirementId: 'customer-records',
          message: 'MCP server missing.',
          nextAction: 'Connect the server.',
        },
      ],
    };

    await notifySchedulerSetupRequired({
      job: makeJob({ name: 'Lead maintenance' }),
      setupState,
      source: 'permission_denied',
      runId: 'run-1',
      sendMessage,
    });

    const message = String(sendMessage.mock.calls[0]?.[1]);
    expect(message).toContain('Failed action: Use Salesforce Leads Append');
    expect(message).toContain(
      'Triggering step: Permission check during the run',
    );
    expect(message).toContain(
      'Run outcome: Died — this run stopped before completing.',
    );
    expect(message).toContain('Blockers (4):');
    expect(message).toContain('1. Salesforce Leads Append');
    expect(message).toContain('2. Browser access');
    expect(message).toContain('3. Tool access: Mcp Gantry Scheduler Run Now');
    expect(message).toContain('4. MCP server: Customer Records');
    expect(message).not.toContain('mcp__gantry__scheduler_run_now');

    sendMessage.mockClear();
    await notifySchedulerSetupRequired({
      job: makeJob({ name: 'Lead maintenance' }),
      setupState: { ...setupState, fingerprint: 'setup-transient' },
      source: 'transient_permission',
      runId: 'run-2',
      sendMessage,
    });
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(
      'Run outcome: Degraded — this run completed with temporary access; future runs are paused.',
    );
  });
});

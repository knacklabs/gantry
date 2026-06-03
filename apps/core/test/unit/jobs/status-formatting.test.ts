import { describe, expect, it } from 'vitest';

import { formatRunStatusMessage } from '@core/jobs/status-formatting.js';
import type { Job } from '@core/domain/types.js';

function job(): Job {
  return {
    id: 'system:dreaming:main_agent:test',
    name: 'Memory Dreaming (main_agent tg:-1003986348737)',
    prompt: '__system:memory_dream',
    schedule_type: 'cron',
    schedule_value: '15 3 * * *',
    session_id: null,
    workspace_key: 'main_agent',
    created_by: 'agent',
    status: 'active',
    next_run: '2026-05-20T21:45:00.000Z',
    silent: false,
    timeout_ms: 300_000,
    max_retries: 1,
    retry_backoff_ms: 30_000,
    max_consecutive_failures: 3,
  } as Job;
}

describe('job status formatting', () => {
  it('adds an explicit action when memory dreaming creates pending reviews', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'completed',
      summary: 'Memory dreaming completed: 3 promoted, 4 sent to review.',
      nextRun: '2026-05-20T21:45:00.000Z',
      retryCount: 0,
      durationMs: 311_000,
    });

    expect(message).toContain('**📝 Needs memory review**');
    expect(message).toContain('· Memory Dreaming');
    expect(message).toContain(
      'Action: Ask the agent to show pending memory reviews, then approve, reject, or edit by number.',
    );
    expect(message).not.toContain('memory_review_pending');
  });

  it('keeps pending memory review action visible on timeout summaries', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'timeout',
      summary:
        'memory dreaming deadline exceeded. 2 pending memory reviews need review.',
      nextRun: null,
      retryCount: 1,
      durationMs: 311_000,
    });

    expect(message).toContain('**⏱️ Timed out**');
    expect(message).toContain('· Memory Dreaming');
    expect(message).toContain(
      'Action: Ask the agent to show pending memory reviews, then approve, reject, or edit by number.',
    );
    expect(message).not.toContain('Action: Rerun with a longer job timeout');
    expect(message).not.toContain('memory_review_pending');
  });
});

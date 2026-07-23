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
      summary: 'Memory dreaming needs attention: 4 sent to review.',
      nextRun: '2026-05-20T21:45:00.000Z',
      retryCount: 0,
      durationMs: 311_000,
    });

    expect(message).toContain('**📝 Needs memory review**');
    expect(message).toContain('· Memory Dreaming');
    expect(message).toContain(
      'Memory dreaming needs attention: 4 sent to review.',
    );
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed:');
    expect(message).not.toContain('Delegated:');
    expect(message).toContain('4 memory changes need your review.');
    expect(message).not.toContain('Needs attention:');
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
    expect(message).toContain("I couldn't finish before the job's time limit.");
    expect(message).not.toContain('memory dreaming deadline exceeded');
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed:');
    expect(message).not.toContain('Delegated:');
    expect(message).toContain('2 memory changes need your review.');
    expect(message).not.toContain('Rerun with a longer job timeout');
    expect(message).not.toContain('memory_review_pending');
  });

  it('omits empty receipt fields and Next without a concrete next run', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'completed',
      summary: 'Completed',
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain(
      'I finished the job, but it had no reportable output.',
    );
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed:');
    expect(message).not.toContain('Delegated:');
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('Next:');
  });

  it('presents completed reports with real attention as completed with issues', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary:
        '## Final Job Report\nCompleted: Imported 3 records.\nNeeds attention: Approve the remaining record.',
      nextRun: '2026-05-20T21:45:00.000Z',
      retryCount: 0,
    });

    expect(message).toContain('**⚠️ Completed with issues**');
    expect(message).toContain('Approve the remaining record.');
    expect(message.match(/Approve the remaining record\./g)).toHaveLength(1);
    expect(message).toContain('Runs again at ');
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('Next:');
  });

  it('keeps the blocker line when the compacted summary truncates it away', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: [
        '## Final Job Report',
        `Completed: ${'Long narrative detail. '.repeat(30)}`,
        'Needs attention: LinkedIn session expired, re-authenticate.',
      ].join('\n'),
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain('**⚠️ Completed with issues**');
    expect(message).toContain('LinkedIn session expired, re-authenticate.');
    expect(message).not.toContain('Needs attention:');
  });

  it('strips trailing agent-authored all-none receipt lines', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: `${[
        '## Final Job Report',
        'Completed: Imported 3 records.',
        'Used: none reported',
        'Changed: none',
        'Delegated: no',
        'Needs attention: n/a',
      ].join('\n')}\n`,
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain('Imported 3 records.');
    expect(message).not.toContain('Completed:');
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed: none');
    expect(message).not.toContain('Delegated: no');
    expect(message).not.toContain('Needs attention:');
  });

  it('renders a parsed terminal tool denial without developer trailer labels', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'failed',
      summary:
        'Tool not on autonomous run allowlist: RunCommand. Recovery: request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false}',
      nextRun: null,
      retryCount: 1,
    });

    expect(message).toContain('Missing RunCommand access for this job.');
    expect(message).toContain('Approve the missing access');
    expect(message).toContain('Stopped until the job is fixed or rerun.');
    expect(message).not.toMatch(
      /^(?:Completed|Used|Changed|Delegated|Needs attention|Next):/m,
    );
    expect(message).not.toContain('request_access');
  });

  it('selects the scoring summary as the reported completed summary', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'completed',
      summary: [
        'Intermediate progress notes that should not be reported.',
        '',
        '## Scoring Summary',
        'Scored 5 candidates: 2 shortlist, 1 hold, 2 reject.',
      ].join('\n'),
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain(
      'Scoring Summary Scored 5 candidates: 2 shortlist, 1 hold, 2 reject.',
    );
    expect(message).not.toContain('Intermediate progress notes');
  });
});

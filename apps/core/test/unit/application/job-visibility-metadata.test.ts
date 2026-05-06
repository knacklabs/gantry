import { describe, expect, it, vi } from 'vitest';

import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
} from '@core/application/jobs/job-visibility-metadata.js';
import type { OpsRepository } from '@core/domain/repositories/ops-repo.js';
import type { Job } from '@core/domain/types.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Once',
    prompt: 'Run once',
    model: null,
    script: null,
    schedule_type: 'once',
    schedule_value: '2026-04-24T09:00:00.000Z',
    status: 'active',
    linked_sessions: ['tg:team'],
    session_id: null,
    thread_id: null,
    group_scope: 'tg:team',
    created_by: 'agent',
    created_at: '2026-04-24T08:00:00.000Z',
    updated_at: '2026-04-24T08:00:00.000Z',
    next_run: '2026-04-24T09:00:00.000Z',
    last_run: null,
    silent: false,
    cleanup_after_ms: 86_400_000,
    timeout_ms: 300_000,
    max_retries: 3,
    retry_backoff_ms: 5_000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    execution_mode: 'parallel',
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

describe('job visibility metadata', () => {
  it('marks active pending once jobs with a missed fire window', async () => {
    const job = makeJob();
    const metadata = await buildJobVisibilityMetadata({
      job,
      ops: { listJobRuns: vi.fn(async () => []) } as unknown as OpsRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.staleness).toBe('missed_window');
  });

  it('exposes missed-window staleness in list metadata without full prompt data', async () => {
    const metadata = await buildJobListVisibilityMetadata({
      jobs: [makeJob()],
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.get('job-1')).toMatchObject({
      promptPreview: 'Run once',
      staleness: 'missed_window',
    });
    expect(metadata.get('job-1')).not.toHaveProperty('fullPrompt');
  });

  it('does not mark completed or future once jobs as stale', async () => {
    const future = await buildJobVisibilityMetadata({
      job: makeJob({ next_run: '2026-04-24T09:30:00.000Z' }),
      ops: { listJobRuns: vi.fn(async () => []) } as unknown as OpsRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });
    const completed = await buildJobVisibilityMetadata({
      job: makeJob({ last_run: '2026-04-24T09:00:05.000Z' }),
      ops: { listJobRuns: vi.fn(async () => []) } as unknown as OpsRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(future.staleness).toBeNull();
    expect(completed.staleness).toBeNull();
  });
});

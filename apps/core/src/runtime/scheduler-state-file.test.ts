import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { Job, JobEvent, JobRun } from '../core/types.js';
import { writeSchedulerStateFile } from './scheduler-state-file.js';

describe('scheduler state file', () => {
  it('writes scheduler jobs/runs JSON to a target path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-scheduler-'));
    const filePath = path.join(tempDir, 'scheduler-jobs.json');

    const jobs: Job[] = [
      {
        id: 'job-1',
        name: 'daily-report',
        prompt: 'run report',
        script: null,
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'active',
        linked_sessions: ['group@g.us'],
        thread_id: null,
        group_scope: 'main',
        created_by: 'agent',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        next_run: '2026-01-01T00:01:00.000Z',
        last_run: null,
        silent: false,
        cleanup_after_ms: 86400000,
        timeout_ms: 300000,
        max_retries: 3,
        retry_backoff_ms: 5000,
        max_consecutive_failures: 5,
        consecutive_failures: 0,
        execution_mode: 'parallel',
        lease_run_id: null,
        lease_expires_at: null,
        pause_reason: null,
      },
    ];

    const runs: JobRun[] = [
      {
        run_id: 'run-1',
        job_id: 'job-1',
        scheduled_for: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:00:02.000Z',
        status: 'completed',
        result_summary: 'done',
        error_summary: null,
        retry_count: 0,
        notified_at: '2026-01-01T00:00:03.000Z',
      },
    ];

    const events: JobEvent[] = [
      {
        id: 1,
        job_id: 'job-1',
        run_id: 'run-1',
        event_type: 'job.completed',
        payload: '{"status":"completed"}',
        created_at: '2026-01-01T00:00:02.000Z',
      },
    ];

    writeSchedulerStateFile(jobs, runs, events, filePath);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      updated_at: string;
      jobs: Job[];
      recent_runs: JobRun[];
      recent_events: JobEvent[];
    };

    expect(saved.jobs).toHaveLength(1);
    expect(saved.jobs[0].id).toBe('job-1');
    expect(saved.recent_runs).toHaveLength(1);
    expect(saved.recent_runs[0].run_id).toBe('run-1');
    expect(saved.recent_events).toHaveLength(1);
    expect(saved.recent_events[0].event_type).toBe('job.completed');
    expect(typeof saved.updated_at).toBe('string');
  });

  it('creates parent directory if it does not exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-scheduler-'));
    const filePath = path.join(tempDir, 'nested', 'dir', 'scheduler-jobs.json');

    writeSchedulerStateFile([], [], [], filePath);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      jobs: Job[];
      recent_runs: JobRun[];
      recent_events: JobEvent[];
    };
    expect(saved.jobs).toHaveLength(0);
    expect(saved.recent_runs).toHaveLength(0);
    expect(saved.recent_events).toHaveLength(0);
  });
});

describe('writeSchedulerStateFileSafe', () => {
  it('does not throw when underlying write fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-scheduler-'));
    const blockingFile = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(blockingFile, 'block');

    vi.doMock('../core/config.js', () => ({
      SCHEDULER_JOBS_JSON_PATH: path.join(blockingFile, 'state.json'),
    }));

    vi.resetModules();
    const mod = await import('./scheduler-state-file.js');

    expect(() => mod.writeSchedulerStateFileSafe([], [], [])).not.toThrow();

    vi.doUnmock('../core/config.js');
    vi.resetModules();
  });
});

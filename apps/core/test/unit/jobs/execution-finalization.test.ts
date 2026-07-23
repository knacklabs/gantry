import { describe, expect, it, vi } from 'vitest';

import { finalizeSchedulerJobRun } from '@core/jobs/execution-finalization.js';
import { createJobRunDiagnostics } from '@core/jobs/execution-diagnostics.js';
import type { SchedulerDependencies } from '@core/jobs/types.js';
import type { Job } from '@core/domain/types.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    app_id: 'default',
    name: 'test',
    prompt: 'run',
    schedule_type: 'manual',
    schedule_value: 'manual',
    status: 'active',
    created_by: 'agent',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    max_retries: 3,
    retry_backoff_ms: 1_000,
    consecutive_failures: 0,
    max_consecutive_failures: 3,
    timeout_ms: 120_000,
    ...overrides,
  } as Job;
}

// A denied tool on a fenced job run is surfaced as an "autonomous allowlist"
// error; finalization must pause (resumable) rather than fail the run.
const DENIAL_ERROR =
  'Tool not on autonomous job allowlist: Bash. Recovery: request_access(capability=shell)';

function makeDeps(): {
  deps: SchedulerDependencies;
  updateJob: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const updateJob = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => true);
  const deps = {
    opsRepository: { updateJob },
    sendMessage,
    onSchedulerChanged: vi.fn(),
  } as unknown as SchedulerDependencies;
  return { deps, updateJob, sendMessage };
}

describe('finalizeSchedulerJobRun — permission ASK on a fenced job', () => {
  it('marks the run paused (not failed) when a tool is denied', async () => {
    const { deps, updateJob } = makeDeps();
    const state = await finalizeSchedulerJobRun({
      currentJob: makeJob(),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      error: DENIAL_ERROR,
      diagnostics: createJobRunDiagnostics(),
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-1',
      publishRuntimeEvent: vi.fn(async () => undefined),
    });

    expect(state.runStatus).toBe('paused');
    expect(state.runStatus).not.toBe('failed');
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('pauses a job with no delivery route (the ask still surfaces)', async () => {
    const { deps, updateJob } = makeDeps();
    const state = await finalizeSchedulerJobRun({
      currentJob: makeJob({ notification_routes: [] }),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      error: DENIAL_ERROR,
      diagnostics: createJobRunDiagnostics(),
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-2',
      publishRuntimeEvent: vi.fn(async () => undefined),
    });

    expect(state.runStatus).toBe('paused');
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'paused' }),
    );
  });
});

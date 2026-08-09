import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { finalizeSchedulerJobRun } from '@core/jobs/execution-finalization.js';
import {
  createJobRunDiagnostics,
  updateDiagnosticsFromRuntimeEvent,
} from '@core/jobs/execution-diagnostics.js';
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

// Anthropic and DeepAgents surface the same parseable autonomous-denial error;
// finalization must fail the dead-end run and pause the job for a fresh retry.
const DENIAL_ERROR =
  'Tool not on autonomous run allowlist: Bash. Recovery: request_access(capability=shell)';

function makeDeps(): {
  deps: SchedulerDependencies;
  updateJob: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const updateJob = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => true);
  const deps = {
    opsRepository: {
      updateJob,
      markJobSetupNotified: vi.fn(async () => '2026-08-09T00:00:00.000Z'),
      confirmJobSetupNotified: vi.fn(async () => undefined),
      clearJobSetupNotified: vi.fn(async () => undefined),
    },
    sendMessage,
    onSchedulerChanged: vi.fn(),
  } as unknown as SchedulerDependencies;
  return { deps, updateJob, sendMessage };
}

describe('execution finalization', () => {
  it('classifies an Anthropic autonomous denial as failed for fresh retry, not resumably paused', async () => {
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

    // Autonomous not-on-allowlist denial: no approver in the loop, so the RUN
    // is a dead-end (failed). The JOB still pauses for setup so an admin can
    // grant access and the job re-runs.
    expect(state.runStatus).toBe('failed');
    expect(state.runStatus).not.toBe('paused');
    expect(state.retryCount).toBe(0);
    expect(state.incrementConsecutiveFailures).toBe(false);
    expect(state.nextRun).toBeNull();
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'paused',
        consecutive_failures: 0,
        setup_state: expect.objectContaining({
          blockers: [expect.objectContaining({ requirementId: 'RunCommand' })],
        }),
      }),
    );
  });

  it('pauses the run on an attended, resumable tool denial', async () => {
    const { deps, updateJob } = makeDeps();
    const diagnostics = createJobRunDiagnostics();
    diagnostics.terminalToolDenial = {
      toolName: 'Bash',
      recoveryAction: 'request_access(capability=shell)',
    };
    const state = await finalizeSchedulerJobRun({
      currentJob: makeJob(),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      // Attended path: a terminal tool denial WITHOUT the autonomous-allowlist
      // message. An approver can resume the same run, so the run pauses.
      error: 'Permission denied for Bash.',
      diagnostics,
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-attended',
      publishRuntimeEvent: vi.fn(async () => undefined),
    });

    expect(state.runStatus).toBe('paused');
    expect(state.runStatus).not.toBe('failed');
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('pauses the job for setup even with no delivery route (autonomous dead-end)', async () => {
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

    expect(state.runStatus).toBe('failed');
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'paused' }),
    );
  });
});

describe('finalizeSchedulerJobRun — transient permission approvals', () => {
  it('keeps a successful recurring job active after reviewed-rule allow_once', async () => {
    const { deps, updateJob } = makeDeps();
    const diagnostics = createJobRunDiagnostics();
    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_allowed',
        tool: 'Bash',
        mode: 'allow_once',
        decidedBy: 'reviewed_rule',
        ok: true,
      },
    );

    const state = await finalizeSchedulerJobRun({
      currentJob: makeJob({
        schedule_type: 'interval',
        schedule_value: '60000',
      }),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      error: null,
      diagnostics,
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-reviewed-rule',
      publishRuntimeEvent: vi.fn(async () => undefined),
    });

    expect(state.runStatus).toBe('completed');
    expect(state.pauseReason).toBeNull();
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'active',
        pause_reason: null,
      }),
    );
    expect(updateJob).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('pauses a successful recurring job after human allow_once', async () => {
    const { deps, updateJob, sendMessage } = makeDeps();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const diagnostics = createJobRunDiagnostics();
    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_allowed',
        tool: 'Bash',
        mode: 'allow_once',
        decidedBy: 'human',
        source: 'human_once',
        repeatableForFutureRuns: false,
        ok: true,
      },
    );

    const state = await finalizeSchedulerJobRun({
      currentJob: makeJob({
        schedule_type: 'interval',
        schedule_value: '60000',
      }),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      error: null,
      diagnostics,
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-human',
      publishRuntimeEvent,
    });

    expect(state.runStatus).toBe('completed');
    expect(state.pauseReason).toBe('Setup required');
    expect(state.setupNotified).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_REQUIRED,
        payload: expect.objectContaining({ notified: false }),
      }),
    );
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'paused',
        next_run: null,
        pause_reason: 'Setup required',
      }),
    );
  });
});

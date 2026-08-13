import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_ENGINE } from '../../../src/shared/agent-engine.js';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { finalizeSchedulerJobRun } from '@core/jobs/execution-finalization.js';
import {
  createJobRunDiagnostics,
  updateDiagnosticsFromRuntimeEvent,
} from '@core/jobs/execution-diagnostics.js';
import type { SchedulerDependencies } from '@core/jobs/types.js';
import type { Job } from '@core/domain/types.js';
import type { JobToolDenial } from '@core/domain/events/job-tool-denial.js';

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

const DENIAL_ERROR =
  'Tool not on autonomous run allowlist: Bash. Recovery: request_access(capability=shell)';

function listDenialEvents(
  denial?: Partial<JobToolDenial>,
): ReturnType<typeof vi.fn> {
  if (!denial) return vi.fn(async () => []);
  const value: JobToolDenial = {
    toolName: 'Bash',
    reason: 'Denied by operator.',
    denialKind: 'permission_denied',
    provenanceLane: DEFAULT_AGENT_ENGINE,
    provenanceSeam: 'gate',
    action: {
      kind: 'approve_grant',
      grant: {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ tool_name: 'RunCommand', rule_content: 'npm test -- unit' }],
      },
    },
    ...denial,
  };
  return vi.fn(async () => [
    {
      eventId: 1,
      appId: 'default',
      eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
      actor: 'scheduler',
      payload: {
        denied_tool: value.toolName,
        reason: value.reason,
        denial_kind: value.denialKind,
        provenance_lane: value.provenanceLane,
        provenance_seam: value.provenanceSeam,
        action: value.action,
        error_summary: DENIAL_ERROR,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  ]);
}

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
      markJobSetupNotified: vi.fn(async () => true),
    },
    sendMessage,
    onSchedulerChanged: vi.fn(),
  } as unknown as SchedulerDependencies;
  return { deps, updateJob, sendMessage };
}

describe('execution finalization', () => {
  it('AUTODET-1-2 > pause card renders grant-naming reason', async () => {
    const { deps, sendMessage } = makeDeps();
    const diagnostics = createJobRunDiagnostics();
    diagnostics.terminalToolDenial = {
      toolName: 'RunCommand',
      reason: 'Worker matcher found no matching allowedTools rule.',
      action: {
        kind: 'approve_grant',
        grant: {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            { tool_name: 'RunCommand', rule_content: 'npm test -- unit' },
          ],
        },
      },
      denialKind: 'permission_denied',
      provenanceLane: DEFAULT_AGENT_ENGINE,
      provenanceSeam: 'gate',
    };

    await finalizeSchedulerJobRun({
      currentJob: makeJob({
        silent: false,
        notification_routes: [
          {
            conversationJid: 'tg:job-owner',
            threadId: 'thread-1',
            label: 'primary',
          },
        ],
      }),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      error:
        'Permission denied. Worker matcher found no matching allowedTools rule.',
      diagnostics,
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-grant-naming-card',
      publishRuntimeEvent: vi.fn(async () => undefined),
      listRuntimeEvents: listDenialEvents(diagnostics.terminalToolDenial),
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]).toContain(
      'Approve exact command access, then resume the job.',
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain(
      'Worker matcher found no matching allowedTools rule.',
    );
  });

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
      listRuntimeEvents: listDenialEvents({ toolName: 'RunCommand' }),
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
          blockers: [expect.objectContaining({ id: 'RunCommand' })],
        }),
      }),
    );
  });

  it('treats the durable typed denial as terminal regardless of error wording', async () => {
    const { deps, updateJob } = makeDeps();
    const diagnostics = createJobRunDiagnostics();
    diagnostics.terminalToolDenial = {
      toolName: 'Bash',
      reason: 'Denied by operator.',
      denialKind: 'permission_denied',
      provenanceLane: DEFAULT_AGENT_ENGINE,
      provenanceSeam: 'gate',
      action: { kind: 'instruction', text: 'Review job setup.' },
    };
    const state = await finalizeSchedulerJobRun({
      currentJob: makeJob(),
      deps,
      scheduledFor: '2024-01-01T00:00:00.000Z',
      now: '2024-01-01T00:00:01.000Z',
      error: 'Permission denied for Bash.',
      diagnostics,
      pausedForSetupDuringRun: false,
      deletedDuringRun: false,
      runtimeAppId: 'default',
      runId: 'run-attended',
      publishRuntimeEvent: vi.fn(async () => undefined),
      listRuntimeEvents: listDenialEvents(diagnostics.terminalToolDenial),
    });

    expect(state.runStatus).toBe('failed');
    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('uses the lowest persisted denial event id as the run authority', async () => {
    const { deps } = makeDeps();
    const event = (eventId: number, toolName: string) => ({
      eventId,
      appId: 'default',
      eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
      actor: 'scheduler' as const,
      payload: {
        denied_tool: toolName,
        reason: 'Denied by operator.',
        denial_kind: 'permission_denied',
        provenance_lane: DEFAULT_AGENT_ENGINE,
        provenance_seam: 'gate',
        action: {
          kind: 'approve_grant',
          grant: {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              { tool_name: 'RunCommand', rule_content: 'npm test -- unit' },
            ],
          },
        },
        error_summary: DENIAL_ERROR,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    });

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
      runId: 'run-primary-denial',
      publishRuntimeEvent: vi.fn(async () => undefined),
      listRuntimeEvents: vi.fn(async () => [
        event(2, 'Browser'),
        event(1, 'RunCommand'),
      ]),
    });

    expect(state.toolDenial?.toolName).toBe('RunCommand');
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
      listRuntimeEvents: listDenialEvents({}),
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
      listRuntimeEvents: listDenialEvents(),
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
      listRuntimeEvents: listDenialEvents(),
    });

    expect(state.runStatus).toBe('completed');
    expect(state.pauseReason).toBe('Setup required');
    expect(state.setupNotified).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_REQUIRED,
        payload: expect.objectContaining({
          blocker_fingerprint: expect.any(String),
        }),
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

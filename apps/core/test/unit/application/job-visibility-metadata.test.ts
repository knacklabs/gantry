import { describe, expect, it, vi } from 'vitest';

import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
} from '@core/application/jobs/job-visibility-metadata.js';
import type { RuntimeJobRepository } from '@core/domain/repositories/ops-repo.js';
import type { Job, JobRun } from '@core/domain/types.js';

function makeRun(overrides: Partial<JobRun> = {}): JobRun {
  return {
    run_id: 'run-1',
    job_id: 'job-1',
    scheduled_for: '2026-04-24T09:00:00.000Z',
    started_at: '2026-04-24T09:00:00.000Z',
    ended_at: '2026-04-24T09:00:05.000Z',
    status: 'completed',
    result_summary: 'Completed',
    error_summary: null,
    retry_count: 0,
    notified_at: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Once',
    prompt: 'Run once',
    model: null,
    schedule_type: 'once',
    schedule_value: '2026-04-24T09:00:00.000Z',
    status: 'active',
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
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.staleness).toBe('missed_window');
    expect(metadata.health.state).toBe('missed_window');
    expect(metadata.health.nextAction).toBe(
      'Run the job now or update its schedule.',
    );
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

  it('does not expose inherited tools from stale bindings without catalog rows', async () => {
    const metadata = await buildJobVisibilityMetadata({
      job: makeJob(),
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => [
          {
            status: 'active',
            toolId: 'tool:Bash',
          },
        ]),
        getTool: vi.fn(async () => null),
      } as never,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.toolAccess.inheritedAgentTools).toEqual([]);
    expect(metadata.toolAccess.effectiveAllowedTools).toEqual([]);
  });

  it('uses the caller app id for inherited tool visibility instead of linked session strings', async () => {
    const listAgentToolBindings = vi.fn(async () => [
      {
        status: 'active',
        toolId: 'tool:Browser',
      },
    ]);
    const metadata = await buildJobVisibilityMetadata({
      job: makeJob({
        session_id: 'session-app-one',
      }),
      appId: 'app-one',
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      toolRepository: {
        listAgentToolBindings,
        getTool: vi.fn(async () => ({ name: 'Browser' })),
      } as never,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(listAgentToolBindings).toHaveBeenCalledWith({
      appId: 'app-one',
      agentId: 'agent:tg:team',
    });
    expect(metadata.toolAccess.inheritedAgentTools).toEqual(['Browser']);
    expect(metadata.toolAccess.effectiveAllowedTools).toEqual(['Browser']);
  });

  it('shows projected browser tools when the canonical Browser capability is inherited', async () => {
    const metadata = await buildJobVisibilityMetadata({
      job: makeJob(),
      appId: 'app-one',
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => [
          {
            status: 'active',
            toolId: 'tool:Browser',
          },
        ]),
        getTool: vi.fn(async () => ({ name: 'Browser' })),
      } as never,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.toolAccess.effectiveAllowedTools).toEqual(['Browser']);
    expect(metadata.toolAccess.projectedRuntimeTools).toEqual(
      expect.arrayContaining([
        'mcp__gantry__browser_act',
        'mcp__gantry__browser_inspect',
      ]),
    );
  });

  it('surfaces missing-permission job health from the latest run summary', async () => {
    const metadata = await buildJobVisibilityMetadata({
      job: makeJob({
        schedule_type: 'interval',
        schedule_value: 'PT1H',
      }),
      ops: {
        listJobRuns: vi.fn(async () => [
          makeRun({
            status: 'dead_lettered',
            error_summary:
              'Tool not on autonomous run allowlist: mcp__gantry__browser_act. Recovery: request_permission { "toolName": "Browser" }',
            result_summary: null,
          }),
        ]),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.health).toMatchObject({
      state: 'needs_permission',
      latestRunId: 'run-1',
      latestRunStatus: 'dead_lettered',
      nextAction: 'request_permission { "toolName": "Browser" }',
    });
  });

  it('surfaces missing-permission list health from persisted pause reason without run history', async () => {
    const metadata = await buildJobListVisibilityMetadata({
      jobs: [
        makeJob({
          status: 'dead_lettered',
          pause_reason: 'Needs permission: mcp__gantry__browser_act',
        }),
      ],
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.get('job-1')?.health).toMatchObject({
      state: 'needs_permission',
      latestRunId: null,
      latestRunStatus: null,
      nextAction: 'Approve Browser access, then rerun the job.',
    });
  });

  it('surfaces latest terminal run health in list metadata', async () => {
    const metadata = await buildJobListVisibilityMetadata({
      jobs: [makeJob({ status: 'active' })],
      ops: {
        listJobRuns: vi.fn(async () => [
          makeRun({
            status: 'timeout',
            result_summary: null,
            error_summary: 'Scheduler run lease expired before completion.',
          }),
        ]),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.get('job-1')?.health).toMatchObject({
      state: 'timed_out',
      latestRunId: 'run-1',
      latestRunStatus: 'timeout',
      latestSummary: 'Scheduler run lease expired before completion.',
      nextAction:
        'Rerun with a longer job timeout if this work is expected to take more time.',
    });
  });

  it('surfaces runtime restart health separately from configured timeouts', async () => {
    const metadata = await buildJobListVisibilityMetadata({
      jobs: [makeJob({ status: 'active' })],
      ops: {
        listJobRuns: vi.fn(async () => [
          makeRun({
            status: 'timeout',
            result_summary: null,
            error_summary: 'Scheduler runtime restarted before completion.',
          }),
        ]),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.get('job-1')?.health).toMatchObject({
      state: 'interrupted',
      latestRunId: 'run-1',
      latestRunStatus: 'timeout',
      latestSummary: 'Scheduler runtime restarted before completion.',
      nextAction:
        'Rerun the job when ready. If this repeats without restarts, increase the job timeout.',
    });
  });

  it('surfaces stale running leases before run history status', async () => {
    const metadata = await buildJobVisibilityMetadata({
      job: makeJob({
        status: 'running',
        lease_run_id: 'run-1',
        lease_expires_at: '2026-04-24T09:00:00.000Z',
      }),
      ops: {
        listJobRuns: vi.fn(async () => [
          makeRun({
            status: 'running',
            ended_at: null,
            result_summary: null,
          }),
        ]),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(metadata.health).toMatchObject({
      state: 'stale_lease',
      activeRunId: 'run-1',
      leaseExpiresAt: '2026-04-24T09:00:00.000Z',
      nextAction: 'Wait for scheduler cleanup, then inspect the latest run.',
    });
  });

  it('derives inherited tool visibility from canonical execution context only', async () => {
    const listAgentToolBindings = vi.fn(async () => []);
    await buildJobVisibilityMetadata({
      job: makeJob(),
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      toolRepository: {
        listAgentToolBindings,
        getTool: vi.fn(async () => null),
      } as never,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(listAgentToolBindings).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:tg:team',
    });
  });

  it('does not mark completed or future once jobs as stale', async () => {
    const future = await buildJobVisibilityMetadata({
      job: makeJob({ next_run: '2026-04-24T09:30:00.000Z' }),
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });
    const completed = await buildJobVisibilityMetadata({
      job: makeJob({ last_run: '2026-04-24T09:00:05.000Z' }),
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(future.staleness).toBeNull();
    expect(completed.staleness).toBeNull();
  });
});

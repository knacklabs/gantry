import { describe, expect, it, vi } from 'vitest';

import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
} from '@core/application/jobs/job-visibility-metadata.js';
import type { RuntimeJobRepository } from '@core/domain/repositories/ops-repo.js';
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
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
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
        toolId: 'tool:Read',
      },
    ]);
    const metadata = await buildJobVisibilityMetadata({
      job: makeJob({
        linked_sessions: ['app:stale-app:conv-1'],
        session_id: 'session-app-one',
      }),
      appId: 'app-one',
      ops: {
        listJobRuns: vi.fn(async () => []),
      } as unknown as RuntimeJobRepository,
      toolRepository: {
        listAgentToolBindings,
        getTool: vi.fn(async () => ({ name: 'Read' })),
      } as never,
      nowMs: Date.parse('2026-04-24T09:10:00.000Z'),
    });

    expect(listAgentToolBindings).toHaveBeenCalledWith({
      appId: 'app-one',
      agentId: 'agent:tg:team',
    });
    expect(metadata.toolAccess.inheritedAgentTools).toEqual(['Read']);
    expect(metadata.toolAccess.effectiveAllowedTools).toEqual(['Read']);
  });

  it('does not derive inherited tool visibility from linked app sessions', async () => {
    const listAgentToolBindings = vi.fn(async () => []);
    await buildJobVisibilityMetadata({
      job: makeJob({ linked_sessions: ['app:stale-app:conv-1'] }),
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

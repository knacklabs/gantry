import { describe, expect, it } from 'vitest';

import type { Job } from '@core/domain/types.js';
import { currentLogContext } from '@core/infrastructure/logging/logger.js';
import { runActiveJobWithLogContext } from '@core/jobs/execution-log-context.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run',
    schedule_type: 'once',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    workspace_key: 'alpha',
    created_by: 'agent',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 0,
    timeout_ms: 30_000,
    max_retries: 0,
    retry_backoff_ms: 0,
    max_consecutive_failures: 1,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

describe('runActiveJobWithLogContext', () => {
  it('uses execution_context agentId for the initial log context', async () => {
    const activeJob = makeJob({
      execution_context: {
        conversationJid: 'sl:C123',
        threadId: null,
        workspaceKey: 'alpha',
        agentId: 'agent:beta',
      } as Job['execution_context'],
    });
    let observedContext: ReturnType<typeof currentLogContext>;

    await runActiveJobWithLogContext({
      requestedJob: activeJob,
      dispatch: {
        runId: 'run-1',
        scheduledFor: '2026-07-17T01:00:00.000Z',
      },
      getJobById: async () => activeJob,
      run: async () => {
        observedContext = currentLogContext();
      },
    });

    expect(observedContext).toEqual({
      runId: 'run-1',
      appId: 'default',
      agentId: 'agent:beta',
    });
  });
});

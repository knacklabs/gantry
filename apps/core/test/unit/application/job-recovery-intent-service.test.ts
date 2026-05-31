import { describe, expect, it, vi } from 'vitest';

import type { Job, JobSetupState } from '@core/domain/types.js';
import {
  createJobRecoveryIntent,
  transitionJobRecoveryIntent,
} from '@core/application/jobs/job-recovery-intent-service.js';

const setupState: JobSetupState = {
  state: 'missing_capability',
  checked_at: '2026-05-23T00:00:00.000Z',
  fingerprint: 'setup-browser',
  blockers: [
    {
      state: 'missing_capability',
      requirementType: 'browser',
      requirementId: 'Browser',
      message: 'This job needs Browser access before it can run.',
      nextAction:
        'request_access {"target":{"kind":"capability","id":"browser.use"},"temporaryOnly":false,"reason":"This autonomous run requires Browser access."}',
    },
  ],
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Browser job',
    prompt: 'Open the dashboard.',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    status: 'paused',
    session_id: null,
    thread_id: null,
    workspace_key: 'main_agent',
    created_by: 'agent',
    created_at: '2026-05-23T00:00:00.000Z',
    updated_at: '2026-05-23T00:00:00.000Z',
    next_run: null,
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
    pause_reason: 'Setup required',
    setup_state: setupState,
    ...overrides,
  };
}

describe('job recovery intent service', () => {
  it('dedupes recovery intents by setup fingerprint and requirement', async () => {
    const updateJob = vi.fn(async () => undefined);
    const first = await createJobRecoveryIntent({
      job: makeJob(),
      setupState,
      source: 'preflight_setup',
      opsRepository: { updateJob } as never,
      now: '2026-05-23T00:01:00.000Z',
    });

    expect(first.created).toBe(true);
    expect(first.intent).toMatchObject({
      kind: 'missing_capability',
      state: 'pending',
      setup_fingerprint: 'setup-browser',
      requirement_type: 'browser',
      requirement_id: 'Browser',
      attempts: 0,
    });

    const second = await createJobRecoveryIntent({
      job: makeJob({ recovery_intent: first.intent }),
      setupState,
      source: 'final_setup',
      opsRepository: { updateJob } as never,
      now: '2026-05-23T00:02:00.000Z',
    });

    expect(second.created).toBe(false);
    expect(second.intent).toBe(first.intent);
    expect(updateJob).toHaveBeenCalledTimes(1);
  });

  it('transitions only the matching recovery intent and records attempts/errors', async () => {
    const updateJob = vi.fn(async () => undefined);
    const created = await createJobRecoveryIntent({
      job: makeJob(),
      setupState,
      source: 'permission_denied',
      runId: 'run-1',
      opsRepository: { updateJob } as never,
      now: '2026-05-23T00:01:00.000Z',
    });

    const running = await transitionJobRecoveryIntent({
      job: makeJob({ recovery_intent: created.intent }),
      dedupeKey: created.intent.dedupe_key,
      state: 'running',
      opsRepository: { updateJob } as never,
      now: '2026-05-23T00:02:00.000Z',
    });

    expect(running).toMatchObject({ state: 'running', attempts: 1 });

    const failed = await transitionJobRecoveryIntent({
      job: makeJob({ recovery_intent: running }),
      dedupeKey: created.intent.dedupe_key,
      state: 'failed',
      error: 'agent turn failed',
      opsRepository: { updateJob } as never,
      now: '2026-05-23T00:03:00.000Z',
    });

    expect(failed).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_error: 'agent turn failed',
    });
    expect(
      await transitionJobRecoveryIntent({
        job: makeJob({ recovery_intent: failed }),
        dedupeKey: 'different',
        state: 'completed',
        opsRepository: { updateJob } as never,
      }),
    ).toBeNull();
  });
});

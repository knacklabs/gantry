import { describe, expect, it, vi } from 'vitest';

import type { Job } from '@core/domain/types.js';
import { publishSchedulerRunCompletion } from '@core/jobs/execution-completion-events.js';

function job(): Job {
  return {
    id: 'job-1',
    app_id: 'app-1',
    agent_task: null,
  } as Job;
}

describe('publishSchedulerRunCompletion', () => {
  it('keeps an externally suspended run non-terminal', async () => {
    const markTriggerCompleted = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await publishSchedulerRunCompletion({
      currentJob: job(),
      runId: 'run-1',
      runStatus: 'paused',
      notified: false,
      startNotified: true,
      summary: 'Waiting for external capability task task-1.',
      pauseReason: 'Waiting for external capability task task-1.',
      nextRun: null,
      boundTriggerId: 'trigger-1',
      eventAppSession: {
        appId: 'app-1',
        sessionId: 'session-1',
      } as never,
      resolveEventAppSession: vi.fn(async () => undefined),
      markTriggerCompleted,
      publishRuntimeEvent,
      runtimeAppId: 'app-1',
      logger: { warn: vi.fn() },
    });

    expect(markTriggerCompleted).toHaveBeenCalledWith('completed');
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
  });

  it('publishes cumulative runtime exhaustion for business review', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await publishSchedulerRunCompletion({
      currentJob: job(),
      runId: 'run-1',
      runStatus: 'paused',
      notified: false,
      startNotified: true,
      summary: 'Cumulative runtime budget exhausted.',
      pauseReason: 'Cumulative runtime budget exhausted.',
      pauseCode: 'cumulative_runtime_exhausted',
      nextRun: null,
      eventAppSession: { appId: 'app-1', sessionId: 'session-1' } as never,
      resolveEventAppSession: vi.fn(async () => undefined),
      markTriggerCompleted: vi.fn(async () => undefined),
      publishRuntimeEvent,
      runtimeAppId: 'app-1',
      logger: { warn: vi.fn() },
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.run.failed',
        payload: expect.objectContaining({
          status: 'paused',
          pauseCode: 'cumulative_runtime_exhausted',
        }),
      }),
    );
  });
});

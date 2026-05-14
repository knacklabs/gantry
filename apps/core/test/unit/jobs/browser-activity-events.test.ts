import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { publishBrowserJobActivityEvent } from '@core/jobs/browser-activity-events.js';

describe('publishBrowserJobActivityEvent', () => {
  it('publishes browser job activity under the job app session', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const getJobById = vi.fn(async () => ({ session_id: 'session-1' }));
    const controlRepository = {
      getAppSessionById: vi.fn(async () => ({
        appId: 'app-1',
        sessionId: 'session-1',
        defaultResponseMode: 'webhook' as const,
        defaultWebhookId: 'webhook-1',
      })),
    };

    await publishBrowserJobActivityEvent({
      activity: {
        jobId: 'job-1',
        runId: 'run-1',
        tool: 'navigate',
        ok: true,
        elapsedMs: 12,
      },
      getJobById,
      controlRepository,
      publishRuntimeEvent,
      runtimeAppId: 'default',
    });

    expect(controlRepository.getAppSessionById).toHaveBeenCalledWith(
      'session-1',
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        sessionId: 'session-1',
        responseMode: 'webhook',
        webhookId: 'webhook-1',
        eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        actor: 'browser',
        jobId: 'job-1',
        runId: 'run-1',
        payload: expect.objectContaining({
          tool: 'navigate',
          ok: true,
          elapsed_ms: 12,
        }),
      }),
    );
  });
});

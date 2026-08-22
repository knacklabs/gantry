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
        invocationId: 'browser-call-1',
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
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
        eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
        actor: 'browser',
        correlationId: 'browser-call-1',
        jobId: 'job-1',
        runId: 'run-1',
        payload: expect.objectContaining({
          tool: 'navigate',
          phase: 'success',
          ok: true,
          invocationId: 'browser-call-1',
          authoritative: true,
        }),
      }),
    );
  });
});

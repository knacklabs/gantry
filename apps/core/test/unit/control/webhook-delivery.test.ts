import { describe, expect, it } from 'vitest';

import { buildWebhookDeliveryEnvelope } from '@core/control/server/webhook-delivery.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

describe('webhook delivery envelope', () => {
  it('projects canonical agent, conversation, and thread ids at top level', () => {
    expect(
      buildWebhookDeliveryEnvelope({
        eventId: 42 as never,
        eventType: RUNTIME_EVENT_TYPES.RUN_COMPLETED,
        agentId: 'agent:one' as never,
        sessionId: 'session:one' as never,
        jobId: 'job:one' as never,
        runId: 'run:one' as never,
        triggerId: 'trigger:one',
        conversationId: 'conversation:one' as never,
        threadId: 'thread:one' as never,
        correlationId: 'correlation:one',
        createdAt: '2026-07-11T00:00:00.000Z' as never,
        payload: { status: 'completed' },
      }),
    ).toEqual({
      eventId: 42,
      eventType: RUNTIME_EVENT_TYPES.RUN_COMPLETED,
      agentId: 'agent:one',
      sessionId: 'session:one',
      jobId: 'job:one',
      runId: 'run:one',
      triggerId: 'trigger:one',
      conversationId: 'conversation:one',
      threadId: 'thread:one',
      correlationId: 'correlation:one',
      createdAt: '2026-07-11T00:00:00.000Z',
      payload: { status: 'completed' },
    });
  });
});

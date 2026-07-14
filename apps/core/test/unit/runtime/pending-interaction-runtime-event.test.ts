import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { publishPendingInteractionRuntimeEvent } from '@core/runtime/ipc-interaction-processing.js';

describe('pending interaction runtime events', () => {
  it('publishes the generic event after durable interaction recording', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await publishPendingInteractionRuntimeEvent(
      { publishRuntimeEvent } as never,
      {
        requestId: 'question:one',
        appId: 'app:one',
        agentId: 'agent:one',
        runId: 'run:one',
        jobId: 'job:one',
        targetJid: 'conversation:one',
        threadId: 'thread:one',
        questions: [],
      } as never,
      'question',
      'main_agent',
    );

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:one',
        agentId: 'agent:one',
        runId: 'run:one',
        jobId: 'job:one',
        conversationId: 'conversation:one',
        threadId: 'thread:one',
        eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
        correlationId: 'question:one',
        payload: {
          kind: 'question',
          requestId: 'question:one',
          sourceAgentFolder: 'main_agent',
          status: 'pending',
        },
      }),
    );
  });
});
